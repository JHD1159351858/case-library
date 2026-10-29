/**
 * PostgreSQL 持久化数据访问层（生产环境）
 *
 * 方法名、入参、返回结构与 database.mjs(SQLite) 严格一致，server.mjs 仅需把
 * 调用改为 await（await 一个 SQLite 同步返回值同样安全）即可无缝切换。
 * 零 npm 依赖，走 pg-wire.mjs 原生协议客户端。
 *
 * 结构真理源：database/schema-postgres.sql（启动时幂等执行）。
 * 与 SQLite 版的差异：
 *   - users.id 用 BIGINT IDENTITY；agents.id 仍是业务字符串主键；
 *   - roles_json 用 JSONB（按 roles_json::text 读取，保持字符串语义）；
 *   - tags/data_json 仍是 TEXT，与 SQLite 完全一致，不做额外解析。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PgClient } from './pg-wire.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'database', 'schema-postgres.sql');

const AGENT_LIST_COLUMNS =
  'id, name, summary, tags, status, discipline, major, course_name, agent_url, school_name, cover_image, updated_at';

const VIEW_STATS_COLUMNS = `
  COALESCE(SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS "userCount",
  COALESCE(SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END), 0) AS "anonymousCount",
  COALESCE(SUM(view_count), 0) AS "viewCount"`
.replace(/\s+/g, ' ').trim();

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function createPgStorage(options) {
  const opts = typeof options === 'string' ? { connectionString: options } : (options ?? {});
  const { connectionString, now = Date.now } = opts;
  if (!connectionString) throw new Error('createPgStorage: 缺少 connectionString');
  const client = new PgClient(connectionString);

  // 启动即验证连接并幂等建表
  await client.query('select 1');
  const schemaSql = await readFile(SCHEMA_PATH, 'utf8');
  for (const stmt of schemaSql.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await client.query(trimmed);
  }

  function mapUser(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      sso_uid: row.sso_uid,
      name: row.name ?? '',
      display_name: row.display_name ?? '',
      role: row.role ?? '',
      roles_json: row.roles_json ?? '[]',
      openid: row.openid ?? '',
      fid: row.fid ?? '',
      org_name: row.org_name ?? '',
      is_admin: Number(row.is_admin ?? 0),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      last_login_at: row.last_login_at == null ? null : Number(row.last_login_at)
    };
  }

  /* ------------------------------ 用户 ------------------------------ */

  async function upsertUserFromIdentity(identity, isAdmin, timestamp) {
    await client.query(`
      INSERT INTO users (sso_uid, name, display_name, role, roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (sso_uid) DO UPDATE SET
        name = EXCLUDED.name,
        display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        roles_json = EXCLUDED.roles_json,
        openid = EXCLUDED.openid,
        fid = EXCLUDED.fid,
        org_name = EXCLUDED.org_name,
        is_admin = EXCLUDED.is_admin,
        updated_at = EXCLUDED.updated_at,
        last_login_at = EXCLUDED.last_login_at
    `, [
      String(identity.ssoUid),
      identity.name ?? '',
      identity.displayName ?? '',
      identity.role ?? '',
      JSON.stringify(Array.isArray(identity.roles) ? identity.roles : []),
      identity.openid ?? '',
      identity.fid ?? '',
      identity.orgName ?? '',
      isAdmin ? 1 : 0,
      timestamp,
      timestamp,
      timestamp
    ]);
    return findUserBySsoUid(identity.ssoUid);
  }

  async function findUserBySsoUid(ssoUid) {
    const r = await client.query(
      'SELECT id, sso_uid, name, display_name, role, roles_json::text AS roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at FROM users WHERE sso_uid = $1',
      [String(ssoUid)]
    );
    return mapUser(r.rows[0]);
  }

  async function findUserById(id) {
    const r = await client.query(
      'SELECT id, sso_uid, name, display_name, role, roles_json::text AS roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at FROM users WHERE id = $1',
      [Number(id)]
    );
    return mapUser(r.rows[0]);
  }

  function updateAdminFlag(userId, isAdmin, timestamp) {
    return client.query('UPDATE users SET is_admin = $1, updated_at = $2 WHERE id = $3',
      [isAdmin ? 1 : 0, timestamp, Number(userId)]);
  }

  /* ------------------------------ 会话 ------------------------------ */

  function createSession({ userId, tokenHash, expiresAt, createdAt }) {
    return client.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ($1,$2,$3,$4)',
      [tokenHash, Number(userId), expiresAt, createdAt]
    );
  }

  async function findSessionUser(tokenHash, timestamp = now()) {
    const sessionRes = await client.query(
      'SELECT token_hash, user_id, expires_at, created_at FROM sessions WHERE token_hash = $1',
      [tokenHash]
    );
    const sessionRow = sessionRes.rows[0];
    if (!sessionRow) return null;
    if (Number(sessionRow.expires_at) <= timestamp) {
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      return null;
    }
    const user = await findUserById(sessionRow.user_id);
    if (!user) {
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      return null;
    }
    return {
      session: {
        token_hash: sessionRow.token_hash,
        user_id: Number(sessionRow.user_id),
        expires_at: Number(sessionRow.expires_at),
        created_at: Number(sessionRow.created_at)
      },
      user
    };
  }

  function deleteSession(tokenHash) {
    return client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  function purgeExpiredSessions(timestamp) {
    return client.query('DELETE FROM sessions WHERE expires_at <= $1', [timestamp]);
  }

  /* ------------------------------ 智能体 ------------------------------ */

  /**
   * 检索 + 筛选 + 分页
   * @returns {Promise<{items:Array,total:number}>}
   */
  async function listAgents({ query = '', discipline = '', school = '', status = '', limit = 100, offset = 0 } = {}) {
    const keyword = String(query ?? '').trim();
    const pattern = `%${escapeLike(keyword)}%`;
    const disciplineVal = String(discipline ?? '').trim();
    const schoolVal = String(school ?? '').trim();
    const statusVal = String(status ?? '').trim();
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);

    const filter = `
      ($1 = ''
        OR name LIKE $2 ESCAPE '\\'
        OR summary LIKE $2 ESCAPE '\\'
        OR tags LIKE $2 ESCAPE '\\'
        OR discipline LIKE $2 ESCAPE '\\'
        OR major LIKE $2 ESCAPE '\\'
        OR course_name LIKE $2 ESCAPE '\\'
        OR school_name LIKE $2 ESCAPE '\\'
        OR pain_point LIKE $2 ESCAPE '\\'
        OR usage_guide LIKE $2 ESCAPE '\\')
      AND ($3 = '' OR discipline = $3)
      AND ($4 = '' OR school_name = $4)
      AND ($5 = '' OR status = $5)`;
    const filterParams = [keyword, pattern, disciplineVal, schoolVal, statusVal];

    const listRes = await client.query(`
      WITH featured AS (
        SELECT slot.agent_id, slot.position
        FROM featured_agent_settings AS settings
        CROSS JOIN LATERAL jsonb_array_elements_text(settings.data_json::jsonb)
          WITH ORDINALITY AS slot(agent_id, position)
        WHERE settings.id = 1 AND slot.agent_id IS NOT NULL
      )
      SELECT ${AGENT_LIST_COLUMNS}
      FROM agents LEFT JOIN featured ON featured.agent_id = agents.id
      WHERE ${filter}
      ORDER BY CASE WHEN featured.position IS NULL THEN 1 ELSE 0 END,
        featured.position ASC, updated_at DESC, id ASC
      LIMIT $6 OFFSET $7
    `, [...filterParams, safeLimit, safeOffset]);

    const countRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM agents WHERE ${filter}`,
      filterParams
    );

    return { items: listRes.rows.map((r) => ({ ...r, updated_at: Number(r.updated_at) })), total: Number(countRes.rows[0].total) };
  }

  async function findAgentById(id) {
    const r = await client.query('SELECT * FROM agents WHERE id = $1', [String(id)]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      ...row,
      created_by: row.created_by == null ? null : Number(row.created_by),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at)
    };
  }

  async function isCoverInUse(coverImage) {
    if (!coverImage) return false;
    const r = await client.query('SELECT id FROM agents WHERE cover_image = $1 LIMIT 1', [coverImage]);
    return r.rows.length > 0;
  }

  async function insertAgent(record) {
    const createdAt = Number(record.createdAt ?? now());
    const updatedAt = Number(record.updatedAt ?? createdAt);
    await client.query(`
      INSERT INTO agents (
        id, name, summary, tags, status, data_json,
        discipline, major, course_name, agent_url, school_name, cover_image, pain_point, usage_guide,
        created_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `, [
      record.id, record.name ?? '', record.summary ?? '', record.tags ?? '', record.status ?? 'active', record.dataJson ?? '{}',
      record.discipline ?? '', record.major ?? '', record.courseName ?? '', record.agentUrl ?? '',
      record.schoolName ?? '', record.coverImage ?? '', record.painPoint ?? '', record.usageGuide ?? '',
      record.createdBy == null ? null : Number(record.createdBy), createdAt, updatedAt
    ]);
    return findAgentById(record.id);
  }

  async function updateAgent(record) {
    await client.query(`
      UPDATE agents SET
        name = $1, summary = $2, tags = $3, status = $4, data_json = $5,
        discipline = $6, major = $7, course_name = $8, agent_url = $9, school_name = $10,
        cover_image = $11, pain_point = $12, usage_guide = $13, updated_at = $14
      WHERE id = $15
    `, [
      record.name ?? '', record.summary ?? '', record.tags ?? '', record.status ?? 'active', record.dataJson ?? '{}',
      record.discipline ?? '', record.major ?? '', record.courseName ?? '', record.agentUrl ?? '',
      record.schoolName ?? '', record.coverImage ?? '', record.painPoint ?? '', record.usageGuide ?? '',
      Number(record.updatedAt ?? now()), record.id
    ]);
    return findAgentById(record.id);
  }

  async function deleteAgent(id) {
    const r = await client.query('DELETE FROM agents WHERE id = $1', [String(id)]);
    return r.rowCount > 0;
  }

  async function countAgents() {
    const r = await client.query('SELECT COUNT(*)::int AS total FROM agents');
    return Number(r.rows[0].total);
  }

  async function agentStats() {
    const total = await countAgents();
    const dRes = await client.query(`
      SELECT discipline, COUNT(*)::int AS total FROM agents
      WHERE discipline <> '' GROUP BY discipline ORDER BY total DESC, discipline ASC
    `);
    const sRes = await client.query(`
      SELECT school_name, COUNT(*)::int AS total FROM agents
      WHERE school_name <> '' GROUP BY school_name ORDER BY total DESC, school_name ASC LIMIT 20
    `);
    return {
      total,
      disciplines: dRes.rows.map((row) => ({ discipline: row.discipline, total: Number(row.total) })),
      schools: sRes.rows.map((row) => ({ schoolName: row.school_name, total: Number(row.total) }))
    };
  }

  /* ------------------------------ 卡片特效配置 ------------------------------ */

  async function cardEffectSettings() {
    const r = await client.query('SELECT data_json, updated_at FROM card_effect_settings WHERE id = 1');
    const row = r.rows[0];
    if (!row) return null;
    return { settings: JSON.parse(row.data_json), updatedAt: Number(row.updated_at) };
  }

  async function saveCardEffectSettings(settings, timestamp = now()) {
    const dataJson = JSON.stringify(settings);
    await client.query(`
      INSERT INTO card_effect_settings (id, data_json, updated_at) VALUES (1, $1, $2)
      ON CONFLICT (id) DO UPDATE SET data_json = EXCLUDED.data_json, updated_at = EXCLUDED.updated_at
    `, [dataJson, timestamp]);
    return { settings: JSON.parse(dataJson), updatedAt: timestamp };
  }

  /* ------------------------------ 手动热门展示位 ------------------------------ */

  async function featuredAgentSettings() {
    const r = await client.query('SELECT data_json, updated_at FROM featured_agent_settings WHERE id = 1');
    const row = r.rows[0];
    if (!row) return { agentIds: [null, null, null], updatedAt: null };
    return { agentIds: normalizeFeaturedAgentIds(row.data_json), updatedAt: Number(row.updated_at) };
  }

  async function saveFeaturedAgentSettings(agentIds, timestamp = now()) {
    const normalized = normalizeFeaturedAgentIds(agentIds);
    await client.query(`
      INSERT INTO featured_agent_settings (id, data_json, updated_at) VALUES (1, $1, $2)
      ON CONFLICT (id) DO UPDATE SET data_json = EXCLUDED.data_json, updated_at = EXCLUDED.updated_at
    `, [JSON.stringify(normalized), timestamp]);
    return { agentIds: normalized, updatedAt: timestamp };
  }

  /* ------------------------------ 浏览统计 ------------------------------ */

  function recordAgentView({ agentId, visitorKey, userId = null, timestamp = now() }) {
    return client.query(`
      INSERT INTO agent_views (agent_id, visitor_key, user_id, view_count, first_viewed_at, last_viewed_at)
      VALUES ($1,$2,$3,1,$4,$4)
      ON CONFLICT (agent_id, visitor_key) DO UPDATE SET
        view_count = agent_views.view_count + 1,
        last_viewed_at = EXCLUDED.last_viewed_at
    `, [String(agentId), visitorKey, userId == null ? null : Number(userId), timestamp]);
  }

  async function agentViewStats(agentId) {
    const r = await client.query(
      `SELECT ${VIEW_STATS_COLUMNS} FROM agent_views WHERE agent_id = $1`,
      [String(agentId)]
    );
    const row = r.rows[0] || { userCount: 0, anonymousCount: 0, viewCount: 0 };
    return {
      userCount: Number(row.userCount),
      anonymousCount: Number(row.anonymousCount),
      viewCount: Number(row.viewCount)
    };
  }

  async function agentViewStatsForAgents(agentIds) {
    const result = new Map(agentIds.map((id) => [id, { userCount: 0, anonymousCount: 0, viewCount: 0 }]));
    if (!agentIds.length) return result;
    // 用 = ANY($1::text[]) 批量聚合（参数以 PG 数组文本传入）
    const r = await client.query(`
      SELECT agent_id, ${VIEW_STATS_COLUMNS}
      FROM agent_views
      WHERE agent_id = ANY($1::text[])
      GROUP BY agent_id
    `, [agentIds.map(String)]);
    for (const row of r.rows) {
      result.set(row.agent_id, {
        userCount: Number(row.userCount),
        anonymousCount: Number(row.anonymousCount),
        viewCount: Number(row.viewCount)
      });
    }
    return result;
  }

  async function listAgentViews(agentId, { limit = 50, offset = 0 } = {}) {
    const parsedLimit = Number.parseInt(limit, 10);
    const parsedOffset = Number.parseInt(offset, 10);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
    const safeOffset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

    const itemsRes = await client.query(`
      SELECT CASE WHEN views.user_id IS NULL THEN 'anonymous' ELSE 'user' END AS "visitorType",
        CASE WHEN views.user_id IS NULL THEN '匿名访客'
          ELSE COALESCE(NULLIF(users.display_name, ''), NULLIF(users.name, ''), '登录用户') END AS "displayName",
        views.view_count AS "viewCount",
        views.first_viewed_at AS "firstViewedAt",
        views.last_viewed_at AS "lastViewedAt"
      FROM agent_views AS views LEFT JOIN users ON users.id = views.user_id
      WHERE views.agent_id = $1
      ORDER BY views.last_viewed_at DESC, views.visitor_key ASC LIMIT $2 OFFSET $3
    `, [String(agentId), safeLimit, safeOffset]);

    const countRes = await client.query('SELECT COUNT(*)::int AS total FROM agent_views WHERE agent_id = $1',
      [String(agentId)]);

    return {
      items: itemsRes.rows.map((row) => ({
        visitorType: row.visitorType,
        displayName: row.displayName,
        viewCount: Number(row.viewCount),
        firstViewedAt: Number(row.firstViewedAt),
        lastViewedAt: Number(row.lastViewedAt)
      })),
      total: Number(countRes.rows[0].total),
      limit: safeLimit,
      offset: safeOffset
    };
  }

  function close() {
    return client.end();
  }

  return {
    upsertUserFromIdentity,
    findUserBySsoUid,
    findUserById,
    updateAdminFlag,
    createSession,
    findSessionUser,
    deleteSession,
    purgeExpiredSessions,
    listAgents,
    findAgentById,
    isCoverInUse,
    insertAgent,
    updateAgent,
    deleteAgent,
    countAgents,
    agentStats,
    cardEffectSettings,
    saveCardEffectSettings,
    featuredAgentSettings,
    saveFeaturedAgentSettings,
    recordAgentView,
    agentViewStats,
    agentViewStatsForAgents,
    listAgentViews,
    close
  };
}

function normalizeFeaturedAgentIds(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) parsed = [];
  return Array.from({ length: 3 }, (_, index) => {
    const id = parsed[index];
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  });
}
