/**
 * 数据库访问层（零依赖，Node 内置 node:sqlite）
 *
 * 结构真理源：<项目根>/database/schema.sql（启动时执行，幂等）
 * 数据文件：<项目根>/database/agent-website.db（可被 DB_PATH 覆盖）
 *
 * 设计约定：
 *   - 本层只做数据存取与约束，不做业务判定（管理员判定、错误映射在 server.mjs）
 *   - 时间一律毫秒时间戳（number）
 *   - 所有写操作通过预编译语句参数化，杜绝字符串拼接
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_URL = new URL('../../database/schema.sql', import.meta.url);

/** 项目根目录（project/backend/database.mjs → 上两级） */
export function projectRoot() {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/**
 * agents 业务列迁移表（列名 → DDL 片段）
 *
 * 新增业务列时在此登记：老库启动时自动 ALTER TABLE 补齐，新库由 schema.sql 直接建全。
 * 只做「加列」，不改类型、不改名、不删列 —— 破坏性变更必须另写迁移脚本。
 */
const AGENT_COLUMN_MIGRATIONS = [
  ['discipline', "TEXT NOT NULL DEFAULT ''"],
  ['major', "TEXT NOT NULL DEFAULT ''"],
  ['course_name', "TEXT NOT NULL DEFAULT ''"],
  ['agent_url', "TEXT NOT NULL DEFAULT ''"],
  ['school_name', "TEXT NOT NULL DEFAULT ''"],
  ['cover_image', "TEXT NOT NULL DEFAULT ''"],
  ['pain_point', "TEXT NOT NULL DEFAULT ''"],
  ['usage_guide', "TEXT NOT NULL DEFAULT ''"]
];

/** 对已存在的 agents 表补齐缺失的业务列（幂等；新建库此时已由 schema.sql 建全） */
export function migrateAgentColumns(database) {
  if (!tableExists(database, 'agents')) return;
  const existing = new Set(
    database.prepare('PRAGMA table_info(agents)').all().map((column) => column.name)
  );
  for (const [column, ddl] of AGENT_COLUMN_MIGRATIONS) {
    if (!existing.has(column)) database.exec(`ALTER TABLE agents ADD COLUMN ${column} ${ddl}`);
  }
}

/** agents 表是否已存在（区分新库与存量库） */
function tableExists(database, tableName) {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

/** 检索与筛选条件（关键词命中业务字段；学科 / 学校 / 状态精确筛选） */
const AGENT_FILTER_SQL = `
  (:keyword = ''
    OR name LIKE :pattern ESCAPE '\\'
    OR summary LIKE :pattern ESCAPE '\\'
    OR tags LIKE :pattern ESCAPE '\\'
    OR discipline LIKE :pattern ESCAPE '\\'
    OR major LIKE :pattern ESCAPE '\\'
    OR course_name LIKE :pattern ESCAPE '\\'
    OR school_name LIKE :pattern ESCAPE '\\'
    OR pain_point LIKE :pattern ESCAPE '\\'
    OR usage_guide LIKE :pattern ESCAPE '\\')
  AND (:discipline = '' OR discipline = :discipline)
  AND (:school = '' OR school_name = :school)
  AND (:status = '' OR status = :status)`;

/** 列表查询返回的列（不含 data_json / 长文本，减小列表体积） */
const AGENT_LIST_COLUMNS =
  'id, name, summary, tags, status, discipline, major, course_name, agent_url, school_name, cover_image, updated_at';

const VIEW_STATS_COLUMNS = `
  COALESCE(SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS userCount,
  COALESCE(SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END), 0) AS anonymousCount,
  COALESCE(SUM(view_count), 0) AS viewCount`;

export function createDatabase({ databasePath, now = Date.now }) {
  const schema = readFileSync(SCHEMA_URL, 'utf8');
  // 确保数据库父目录存在（生产环境 DB_PATH 指向 /tmp 子目录时必需）
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  // 存量库的 agents 表可能缺业务列：必须先补列，schema.sql 中的新列索引才能建立
  if (tableExists(database, 'agents')) migrateAgentColumns(database);
  database.exec(schema);
  migrateAgentColumns(database);

  const statements = {
    upsertUser: database.prepare(`
      INSERT INTO users (sso_uid, name, display_name, role, roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sso_uid) DO UPDATE SET
        name = excluded.name,
        display_name = excluded.display_name,
        role = excluded.role,
        roles_json = excluded.roles_json,
        openid = excluded.openid,
        fid = excluded.fid,
        org_name = excluded.org_name,
        is_admin = excluded.is_admin,
        updated_at = excluded.updated_at,
        last_login_at = excluded.last_login_at
    `),
    findUserBySsoUid: database.prepare('SELECT * FROM users WHERE sso_uid = ?'),
    findUserById: database.prepare('SELECT * FROM users WHERE id = ?'),
    updateAdminFlag: database.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?'),
    insertSession: database.prepare(`
      INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
    `),
    findSession: database.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    listAgents: database.prepare(`
      SELECT ${AGENT_LIST_COLUMNS}
      FROM agents
      WHERE ${AGENT_FILTER_SQL}
      ORDER BY updated_at DESC, id ASC
      LIMIT :limit OFFSET :offset
    `),
    countAgentsFiltered: database.prepare(`
      SELECT COUNT(*) AS total FROM agents WHERE ${AGENT_FILTER_SQL}
    `),
    findAgent: database.prepare('SELECT * FROM agents WHERE id = ?'),
    findAgentByCover: database.prepare('SELECT id FROM agents WHERE cover_image = ? LIMIT 1'),
    insertAgent: database.prepare(`
      INSERT INTO agents (
        id, name, summary, tags, status, data_json,
        discipline, major, course_name, agent_url, school_name, cover_image, pain_point, usage_guide,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateAgent: database.prepare(`
      UPDATE agents SET
        name = ?, summary = ?, tags = ?, status = ?, data_json = ?,
        discipline = ?, major = ?, course_name = ?, agent_url = ?, school_name = ?,
        cover_image = ?, pain_point = ?, usage_guide = ?, updated_at = ?
      WHERE id = ?
    `),
    deleteAgent: database.prepare('DELETE FROM agents WHERE id = ?'),
    countAgents: database.prepare('SELECT COUNT(*) AS total FROM agents'),
    disciplineStats: database.prepare(`
      SELECT discipline, COUNT(*) AS total FROM agents
      WHERE discipline != '' GROUP BY discipline ORDER BY total DESC, discipline ASC
    `),
    schoolStats: database.prepare(`
      SELECT school_name, COUNT(*) AS total FROM agents
      WHERE school_name != '' GROUP BY school_name ORDER BY total DESC, school_name ASC LIMIT 20
    `),
    recordAgentView: database.prepare(`
      INSERT INTO agent_views (agent_id, visitor_key, user_id, view_count, first_viewed_at, last_viewed_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(agent_id, visitor_key) DO UPDATE SET
        view_count = agent_views.view_count + 1,
        last_viewed_at = excluded.last_viewed_at
    `),
    agentViewStats: database.prepare(`
      SELECT ${VIEW_STATS_COLUMNS} FROM agent_views WHERE agent_id = ?
    `),
    agentViewStatsForAgents: database.prepare(`
      SELECT agent_id, ${VIEW_STATS_COLUMNS} FROM agent_views
      WHERE agent_id IN (SELECT value FROM json_each(?)) GROUP BY agent_id
    `),
    listAgentViews: database.prepare(`
      SELECT CASE WHEN views.user_id IS NULL THEN 'anonymous' ELSE 'user' END AS visitorType,
        CASE WHEN views.user_id IS NULL THEN '匿名访客'
          ELSE COALESCE(NULLIF(users.display_name, ''), NULLIF(users.name, ''), '登录用户') END AS displayName,
        views.view_count AS viewCount,
        views.first_viewed_at AS firstViewedAt,
        views.last_viewed_at AS lastViewedAt
      FROM agent_views AS views LEFT JOIN users ON users.id = views.user_id
      WHERE views.agent_id = ?
      ORDER BY views.last_viewed_at DESC, views.visitor_key ASC LIMIT ? OFFSET ?
    `),
    countAgentViews: database.prepare(`
      SELECT COUNT(*) AS total FROM agent_views WHERE agent_id = ?
    `),
    cardEffectSettings: database.prepare('SELECT data_json, updated_at FROM card_effect_settings WHERE id = 1'),
    saveCardEffectSettings: database.prepare(`
      INSERT INTO card_effect_settings (id, data_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `)
  };

  return {
    /** 登录时按认证中心身份建档 / 更新档案，返回最新用户行 */
    upsertUserFromIdentity(identity, isAdmin, timestamp) {
      statements.upsertUser.run(
        identity.ssoUid,
        identity.name,
        identity.displayName,
        identity.role,
        JSON.stringify(identity.roles ?? []),
        identity.openid,
        identity.fid,
        identity.orgName,
        isAdmin ? 1 : 0,
        timestamp,
        timestamp,
        timestamp
      );
      return statements.findUserBySsoUid.get(identity.ssoUid);
    },

    findUserBySsoUid(ssoUid) {
      return statements.findUserBySsoUid.get(ssoUid) ?? null;
    },

    findUserById(id) {
      return statements.findUserById.get(id) ?? null;
    },

    /** 实时管理员判定的落库（配置变化后向用户响应时同步） */
    updateAdminFlag(userId, isAdmin, timestamp) {
      statements.updateAdminFlag.run(isAdmin ? 1 : 0, timestamp, userId);
    },

    createSession({ userId, tokenHash, expiresAt, createdAt }) {
      statements.insertSession.run(tokenHash, userId, expiresAt, createdAt);
    },

    /** 按 token 摘要取会话用户；过期即删并返回 null */
    findSessionUser(tokenHash, timestamp) {
      const session = statements.findSession.get(tokenHash);
      if (!session) return null;
      if (session.expires_at <= timestamp) {
        statements.deleteSession.run(tokenHash);
        return null;
      }
      const user = statements.findUserById.get(session.user_id);
      if (!user) {
        statements.deleteSession.run(tokenHash);
        return null;
      }
      return { session, user };
    },

    deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },

    purgeExpiredSessions(timestamp) {
      statements.purgeSessions.run(timestamp);
    },

    /**
     * 检索 + 筛选 + 分页
     * @param {{ query?:string, discipline?:string, school?:string, status?:string, limit?:number, offset?:number }} options
     * @returns {{ items:Array, total:number }}
     */
    listAgents({ query = '', discipline = '', school = '', status = '', limit = 100, offset = 0 } = {}) {
      const keyword = String(query ?? '').trim();
      const params = {
        keyword,
        pattern: `%${escapeLike(keyword)}%`,
        discipline: String(discipline ?? '').trim(),
        school: String(school ?? '').trim(),
        status: String(status ?? '').trim()
      };
      const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
      const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
      const items = statements.listAgents.all({ ...params, limit: safeLimit, offset: safeOffset });
      const total = statements.countAgentsFiltered.get(params).total;
      return { items, total };
    },

    findAgentById(id) {
      return statements.findAgent.get(id) ?? null;
    },

    /** 封面是否仍被某条记录引用（删除封面文件前的引用检查） */
    isCoverInUse(coverImage) {
      if (!coverImage) return false;
      return Boolean(statements.findAgentByCover.get(coverImage));
    },

    insertAgent(record) {
      statements.insertAgent.run(
        record.id,
        record.name,
        record.summary,
        record.tags,
        record.status,
        record.dataJson,
        record.discipline,
        record.major,
        record.courseName,
        record.agentUrl,
        record.schoolName,
        record.coverImage,
        record.painPoint,
        record.usageGuide,
        record.createdBy,
        record.createdAt,
        record.updatedAt
      );
      return statements.findAgent.get(record.id);
    },

    /** 全量更新（调用方先取原行合并字段，未提供字段保持原值） */
    updateAgent(record) {
      statements.updateAgent.run(
        record.name,
        record.summary,
        record.tags,
        record.status,
        record.dataJson,
        record.discipline,
        record.major,
        record.courseName,
        record.agentUrl,
        record.schoolName,
        record.coverImage,
        record.painPoint,
        record.usageGuide,
        record.updatedAt,
        record.id
      );
      return statements.findAgent.get(record.id);
    },

    /** @returns {boolean} 是否真的删除了记录 */
    deleteAgent(id) {
      return statements.deleteAgent.run(id).changes > 0;
    },

    countAgents() {
      return statements.countAgents.get().total;
    },

    /** 管理端概览：总数 + 学科分布 + 学校分布 */
    agentStats() {
      return {
        total: statements.countAgents.get().total,
        disciplines: statements.disciplineStats
          .all()
          .map((row) => ({ discipline: row.discipline, total: row.total })),
        schools: statements.schoolStats.all().map((row) => ({ schoolName: row.school_name, total: row.total }))
      };
    },

    cardEffectSettings() {
      const row = statements.cardEffectSettings.get();
      return row ? { settings: JSON.parse(row.data_json), updatedAt: row.updated_at } : null;
    },

    saveCardEffectSettings(settings, timestamp = now()) {
      const dataJson = JSON.stringify(settings);
      statements.saveCardEffectSettings.run(dataJson, timestamp);
      return { settings: JSON.parse(dataJson), updatedAt: timestamp };
    },

    /** 访客身份由请求层确定；统计写入不修改案例更新时间。 */
    recordAgentView({ agentId, visitorKey, userId = null, timestamp = now() }) {
      statements.recordAgentView.run(agentId, visitorKey, userId, timestamp, timestamp);
    },

    agentViewStats(agentId) {
      return { ...statements.agentViewStats.get(agentId) };
    },

    /** 一次聚合当前页的全部案例，避免管理员列表逐条查询。 */
    agentViewStatsForAgents(agentIds) {
      const result = new Map(agentIds.map((id) => [id, { userCount: 0, anonymousCount: 0, viewCount: 0 }]));
      if (!agentIds.length) return result;
      for (const row of statements.agentViewStatsForAgents.all(JSON.stringify(agentIds))) {
        result.set(row.agent_id, { userCount: row.userCount, anonymousCount: row.anonymousCount, viewCount: row.viewCount });
      }
      return result;
    },

    /** 管理员明细只返回展示字段，不暴露账号标识或匿名访客键。 */
    listAgentViews(agentId, { limit = 50, offset = 0 } = {}) {
      const parsedLimit = Number.parseInt(limit, 10);
      const parsedOffset = Number.parseInt(offset, 10);
      const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
      const safeOffset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;
      return {
        items: statements.listAgentViews.all(agentId, safeLimit, safeOffset).map((row) => ({ ...row })),
        total: statements.countAgentViews.get(agentId).total,
        limit: safeLimit,
        offset: safeOffset
      };
    },

    close() {
      database.close();
    }
  };
}

/** LIKE 通配符转义（配合 ESCAPE '\'） */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
