/**
 * agent-official-website 后端服务（Node 内置模块，零依赖）
 *
 * 职责：
 *   1. 托管 project/frontend 静态资源（首页 / 智能体查询平台 / 管理端）
 *   2. 超星 SSO 联登：跳认证中心授权 → 回调接收一次性 ticket → 调认证中心
 *      POST /api/sso/verify 验票 → 建立本站会话并种 Cookie
 *   3. 智能体数据接口：/api/agents 查询、详情；新增仅管理员（新增后可继续迭代字段）
 *
 * 认证中心契约（doc/sso-integration.md 有完整说明）：
 *   授权：GET  {SSO_CENTER_URL}/api/auth/chaoxing?return_to=<本服务回调绝对URL>
 *   回调：GET  本服务 {APP_PUBLIC_URL}/api/auth/chaoxing/callback?ticket=xxx
 *   验票：POST {SSO_CENTER_URL}/api/sso/verify  body {ticket, secret}
 *         200 身份 JSON / 401 invalid_secret / 400 invalid_ticket
 *         410 ticket_used | ticket_expired
 *   登出：GET  {SSO_CENTER_URL}/api/auth/logout?return_to=<回跳地址>
 *
 * 安全约定：
 *   - SSO_SHARED_SECRET 仅存服务端，绝不下发浏览器（响应体与静态资源均不含）
 *   - return_to 仅接受白名单 origin 的绝对 URL 或站内相对路径，其余忽略
 *   - 会话 Cookie HttpOnly + SameSite=Lax，数据库只存 token 的 sha256 摘要
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, projectRoot } from './database.mjs';
import { createPgStorage } from './pg-storage.mjs';
import { CARD_EFFECT_FIELDS, DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings } from '../frontend/js/card-effect-settings.js';

export const SESSION_COOKIE_NAME = 'agent_site_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const VISITOR_COOKIE_NAME = 'agent_site_visitor';
const VISITOR_TTL_SECONDS = 365 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** 封面图片上传限制与白名单（MIME → 落盘扩展名） */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const COVER_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
};
export const UPLOAD_URL_PREFIX = '/uploads/';

/* ============================================================================
 * 配置
 * ========================================================================== */

/** 逗号分隔列表 → 去空去重数组（数组输入同样去重，保持两条路径行为一致） */
export function splitList(value) {
  const items = Array.isArray(value)
    ? value.map((item) => String(item).trim())
    : typeof value === 'string'
      ? value.split(',').map((item) => item.trim())
      : [];
  return [...new Set(items.filter(Boolean))];
}

function trimEndSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/**
 * 解析运行配置（环境变量 + 显式覆盖，覆盖优先，便于测试注入）
 * @returns {{ port:number, host:string, appPublicUrl:string, ssoCenterUrl:string,
 *             ssoSharedSecret:string, allowedReturnOrigins:string[], adminRoles:string[],
 *             adminSsoUids:string[], dbPath:string, frontendDir:string, uploadsDir:string }}
 */
export function parseEnvConfig(environment = process.env, overrides = {}) {
  const pick = (key, fallback = undefined) =>
    overrides[key] !== undefined ? overrides[key] : (environment[key] ?? fallback);

  const port = Number.parseInt(String(pick('port', pick('BACKEND_PORT', pick('PORT', 2001)))), 10) || 2001;
  const host = String(pick('host', environment.BACKEND_HOST ?? '127.0.0.1'));
  const appPublicUrlOverride = overrides.appPublicUrl !== undefined ? String(overrides.appPublicUrl) : String(environment.APP_PUBLIC_URL ?? '');
  const appPublicUrlExplicit = Boolean(appPublicUrlOverride.trim());
  const appPublicUrl = trimEndSlash(appPublicUrlExplicit ? appPublicUrlOverride : `http://127.0.0.1:${port}`);
  const ssoCenterUrl = trimEndSlash(String(pick('ssoCenterUrl', environment.SSO_CENTER_URL ?? '')));
  const ssoSharedSecret = String(pick('ssoSharedSecret', environment.SSO_SHARED_SECRET ?? ''));

  const allowedReturnOrigins = splitList(
    pick('returnOrigins', environment.SSO_ALLOWED_RETURN_ORIGINS ?? '')
  );
  const fallbackOrigin = safeOrigin(appPublicUrl);
  const allowedOrigins = [...new Set([...allowedReturnOrigins.map(safeOrigin).filter(Boolean), ...(fallbackOrigin ? [fallbackOrigin] : [])])];

  const adminRoles = splitList(pick('adminRoles', environment.ADMIN_ROLES ?? 'admin')).map((role) => role.toLowerCase());
  const adminSsoUids = splitList(pick('adminSsoUids', environment.ADMIN_SSO_UIDS ?? ''));

  const root = projectRoot();
  const dbPath = resolve(root, String(pick('dbPath', environment.DB_PATH ?? join('database', 'agent-website.db'))));
  const frontendDir = resolve(root, String(pick('frontendDir', environment.FRONTEND_DIR ?? join('project', 'frontend'))));
  const uploadsDir = resolve(root, String(pick('uploadsDir', environment.UPLOADS_DIR ?? join('database', 'uploads'))));

  return {
    port,
    host,
    appPublicUrl,
    appPublicUrlExplicit,
    ssoCenterUrl,
    ssoSharedSecret,
    allowedReturnOrigins: allowedOrigins,
    adminRoles: adminRoles.length ? adminRoles : ['admin'],
    adminSsoUids,
    dbPath,
    frontendDir,
    uploadsDir
  };
}

/**
 * 从请求头推导本服务对外 origin（反向代理/网关后自动适配任意域名）。
 * 优先 x-forwarded-proto + x-forwarded-host，回退 host；本地地址默认 http，其余默认 https。
 * @param {import('node:http').IncomingMessage} request
 * @returns {string} 形如 https://example.com 的 origin；无法推导返回 ''
 */
export function requestPublicOrigin(request) {
  const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim();
  if (!host) return '';
  const isLocal = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?$/i.test(host);
  const scheme = proto || (isLocal ? 'http' : 'https');
  return `${scheme}://${host}`;
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/* ============================================================================
 * SSO 契约：return_to 白名单、授权地址、验票、身份归一
 * ========================================================================== */

/**
 * 解析并校验 return_to：
 *   - 站内相对路径（/xxx，且非 //）→ 转为本站绝对 URL
 *   - 绝对 URL → origin 必须命中白名单，否则拒绝
 * @param {string} returnTo 待校验的 return_to 原始值
 * @param {{ allowedReturnOrigins:string[], appPublicUrl:string }} config 运行配置
 * @returns {string|null} 归一后的绝对 URL；非法返回 null（调用方按无参数处理）
 */
export function resolveReturnTo(returnTo, { allowedReturnOrigins = [], appPublicUrl }) {
  const value = typeof returnTo === 'string' ? returnTo.trim() : '';
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return `${appPublicUrl}${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!allowedReturnOrigins.includes(url.origin)) return null;
  return url.toString();
}

/** 本服务默认回调地址（授权入口不带 return_to 时使用） */
export function defaultCallbackUrl(appPublicUrl) {
  return `${appPublicUrl}/api/auth/chaoxing/callback`;
}

/** 认证中心授权地址 */
export function buildSsoStartUrl({ ssoCenterUrl, returnTo }) {
  const target = new URL('/api/auth/chaoxing', ssoCenterUrl);
  target.searchParams.set('return_to', returnTo);
  return target.toString();
}

/**
 * 认证中心登出地址（清理其在认证中心域的会话）；未配置认证中心时回本站
 *
 * 契约实测（2026-09）：认证中心登出端点为 /api/auth/logout（GET，302）。
 * 该端点当前实现忽略 return_to，固定跳认证中心首页；参数仍携带以便其后续支持回跳。
 */
export function buildSsoLogoutUrl({ ssoCenterUrl, returnTo }) {
  if (!ssoCenterUrl) return returnTo;
  const target = new URL('/api/auth/logout', ssoCenterUrl);
  target.searchParams.set('return_to', returnTo);
  return target.toString();
}

/**
 * 调用认证中心验票
 * @returns {{ status:number, ok:boolean, data:any, error?:string }}
 */
export async function verifySsoTicket({ fetchImpl = fetch, ssoCenterUrl, secret, ticket }) {
  const endpoint = `${new URL(ssoCenterUrl).origin}/api/sso/verify`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ ticket, secret })
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    return { status: 0, ok: false, data: null, error: error?.message ?? 'network_error' };
  }
}

/** 验票失败 → 页面错误码（前端映射为中文提示） */
export function mapVerifyFailure(result) {
  if (!result || result.status === 0) return 'verify_failed';
  if (result.status === 401) return 'invalid_secret';
  if (result.status === 400) return 'invalid_ticket';
  if (result.status === 410) {
    return result.data?.error === 'ticket_used' ? 'ticket_used' : 'ticket_expired';
  }
  return 'verify_failed';
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * 认证中心身份 → 本站用户档案（字段宽松解析，uid 缺失视为无效身份）
 * 认证中心权威契约：{ name, displayName, fid, roles:[{roleId, roleName}] } + uid
 */
export function normalizeIdentity(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const ssoUid = firstString(payload.uid, payload.userId, payload.userid, payload.user_id, payload.sub);
  if (!ssoUid) return null;
  const roles = Array.isArray(payload.roles)
    ? payload.roles
        .map((item) => {
          if (typeof item === 'string') return { roleId: '', roleName: item };
          if (item && typeof item === 'object') {
            return {
              roleId: firstString(item.roleId, item.role_id, item.id),
              roleName: firstString(item.roleName, item.role_name, item.name)
            };
          }
          return null;
        })
        .filter(Boolean)
    : [];
  const role = firstString(payload.role) || roles[0]?.roleName || '';
  const name = firstString(payload.name, payload.userName, payload.username);
  return {
    ssoUid,
    name,
    displayName: firstString(payload.displayName, payload.display_name, payload.nickName, payload.nickname) || name,
    role,
    roles,
    openid: firstString(payload.openid),
    fid: firstString(payload.fid),
    orgName: firstString(payload.orgName, payload.org_name, payload.org)
  };
}

/** 管理员判定：ADMIN_SSO_UIDS 命中，或 role / roles 命中 ADMIN_ROLES（大小写不敏感） */
export function computeIsAdmin(user, { adminRoles, adminSsoUids }) {
  if (!user) return false;
  if (adminSsoUids.includes(user.sso_uid)) return true;
  const roleSet = new Set((adminRoles ?? []).map((role) => String(role).toLowerCase()));
  if (!roleSet.size) return false;
  const candidates = [user.role];
  try {
    const roles = JSON.parse(user.roles_json || '[]');
    for (const item of roles) {
      if (typeof item === 'string') candidates.push(item);
      else if (item && typeof item === 'object') candidates.push(item.roleName, item.roleId);
    }
  } catch {
    /* roles_json 损坏时按 role 判定 */
  }
  return candidates.some((value) => value !== undefined && value !== null && roleSet.has(String(value).toLowerCase()));
}

/** 登录身份的管理员判定（落库前，还没有 users 行） */
export function isAdminIdentity(identity, config) {
  return computeIsAdmin(
    { sso_uid: identity.ssoUid, role: identity.role, roles_json: JSON.stringify(identity.roles ?? []) },
    config
  );
}

/* ============================================================================
 * 智能体（案例）字段归一与校验
 * ========================================================================== */

/** 各文本字段长度上限（超出即 400，与前端 maxlength 保持一致） */
export const AGENT_FIELD_LIMITS = {
  name: 120,
  summary: 500,
  tags: 200,
  discipline: 60,
  major: 60,
  courseName: 120,
  schoolName: 120,
  agentUrl: 500,
  coverImage: 500,
  painPoint: 2000,
  usageGuide: 5000
};

export const AGENT_STATUSES = ['active', 'inactive'];

/** 文本归一：去首尾空白 + 长度校验 */
function normalizeText(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length > limit) return null;
  return text;
}

/**
 * 链接归一：空串放行；站内相对路径（/xxx）放行；http(s) 绝对地址放行；其余判非法。
 * @returns {string|null} null 表示格式非法
 */
export function normalizeAgentUrl(value) {
  const raw = String(value ?? '');
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  const text = raw.trim();
  if (!text) return '';
  const internal = text.startsWith('/') && !text.startsWith('//');
  if (!internal && !/^https?:\/\//i.test(text)) return null;
  try {
    const base = 'https://agent.invalid';
    const parsed = new URL(text, base);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    if (internal && parsed.origin !== base) return null;
    return text;
  } catch {
    return null;
  }
}

/** 封面地址归一：站内 /uploads/ 路径或 http(s) 外链 */
function normalizeCoverImage(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.startsWith(UPLOAD_URL_PREFIX)) return text;
  if (/^https?:\/\//i.test(text)) return text;
  return null;
}

/**
 * 新建 / 更新共用的字段解析
 * @param {any} body 请求体
 * @param {{ partial?:boolean }} options partial=true 时（PUT）未提供的字段返回 undefined，由调用方保留原值
 * @returns {{ ok:true, value:object }|{ ok:false, error:string }}
 */
export function normalizeAgentInput(body, { partial = false } = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const value = {};
  // partial=true（PUT）时未提供字段返回 undefined，由调用方保留原值；否则未提供按空串处理
  const pick = (key) =>
    partial ? source[key] : (source[key] === undefined || source[key] === null ? '' : source[key]);

  const textFields = [
    ['name', AGENT_FIELD_LIMITS.name],
    ['summary', AGENT_FIELD_LIMITS.summary],
    ['tags', AGENT_FIELD_LIMITS.tags],
    ['discipline', AGENT_FIELD_LIMITS.discipline],
    ['major', AGENT_FIELD_LIMITS.major],
    ['courseName', AGENT_FIELD_LIMITS.courseName],
    ['schoolName', AGENT_FIELD_LIMITS.schoolName],
    ['painPoint', AGENT_FIELD_LIMITS.painPoint],
    ['usageGuide', AGENT_FIELD_LIMITS.usageGuide]
  ];
  for (const [key, limit] of textFields) {
    const raw = pick(key);
    if (raw === undefined) continue;
    const normalized = normalizeText(raw, limit);
    if (normalized === null) return { ok: false, error: `${key}_too_long` };
    value[key] = normalized;
  }

  if (value.name !== undefined && !value.name) return { ok: false, error: 'name_required' };

  const rawUrl = pick('agentUrl');
  if (rawUrl !== undefined) {
    const url = normalizeAgentUrl(rawUrl);
    if (url === null) return { ok: false, error: 'invalid_agent_url' };
    value.agentUrl = url;
  }

  const rawCover = pick('coverImage');
  if (rawCover !== undefined) {
    const cover = normalizeCoverImage(rawCover);
    if (cover === null) return { ok: false, error: 'invalid_cover_image' };
    value.coverImage = cover;
  }

  const rawStatus = pick('status');
  if (rawStatus !== undefined) {
    const status = String(rawStatus ?? '').trim() || 'active';
    if (!AGENT_STATUSES.includes(status)) return { ok: false, error: 'invalid_status' };
    value.status = status;
  }

  // dataJson 优先；缺省时回退 data。未提供（undefined/null）在 partial 模式下保留原值
  const dataSource = source.dataJson ?? source.data;
  const rawData = partial ? dataSource : (dataSource ?? '');
  if (rawData !== undefined && rawData !== null && rawData !== '') {
    if (typeof rawData === 'string') {
      let parsed;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return { ok: false, error: 'invalid_data_json' };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'invalid_data_json' };
      }
      value.dataJson = JSON.stringify(parsed);
    } else if (typeof rawData === 'object' && !Array.isArray(rawData)) {
      value.dataJson = JSON.stringify(rawData);
    } else {
      return { ok: false, error: 'invalid_data_json' };
    }
  }

  return { ok: true, value };
}

/** 对话只接受有限长度的用户 / 助手消息，额外身份字段不会传给 AI。 */
export function normalizeAgentChatMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const messages = [];
  for (const message of value) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return null;
    const content = message.content.trim();
    if (!content || content.length > 2000) return null;
    messages.push({ role: message.role, content });
  }
  return messages.at(-1).role === 'user' ? messages : null;
}

/* ============================================================================
 * 会话与 Cookie
 * ========================================================================== */

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return randomBytes(32).toString('base64url');
}

function cookieValue(request, name) {
  const raw = request.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const item of raw.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) return item.slice(index + 1).trim() || null;
  }
  return null;
}

function isSecureRequest(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (forwarded) return forwarded === 'https';
  return Boolean(request.socket?.encrypted);
}

export function serializeSessionCookie(token, maxAgeSeconds, { secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function serializeVisitorCookie(token, { secure = false } = {}) {
  const parts = [
    `${VISITOR_COOKIE_NAME}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${VISITOR_TTL_SECONDS}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ============================================================================
 * HTTP 工具
 * ========================================================================== */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    // 超限后不再累积，但继续消费剩余数据（不 destroy 请求），
    // 否则 413 响应无法写回客户端，前端只能看到连接中断而非可读的失败提示。
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.resume();
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        fail(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { code: 'invalid_json' }));
      }
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 读取原始请求体（用于二进制上传，超限即中止累积但保持响应可写） */
function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.resume();
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * 图片魔数（文件头）识别：内容必须真的是图片，不能只信客户端声明的 MIME
 * @param {Buffer} data 文件内容
 * @returns {string} 归一后的 MIME；无法识别返回空串
 */
export function sniffImageMime(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return '';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const head6 = data.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

/**
 * 从 multipart/form-data 请求体中提取第一个文件字段
 * @returns {{ field:string, fileName:string, contentType:string, data:Buffer }|null}
 */
export function extractUploadFile(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  // 分隔符必须独占一行；图片字节中相同或近似的字符串属于文件内容。
  const findDelimiter = (start) => {
    let index = buffer.indexOf(delimiter, start);
    while (index >= 0) {
      const end = index + delimiter.length;
      const lineStart = index === 0 || buffer.subarray(index - 2, index).toString() === '\r\n';
      const suffix = buffer.subarray(end, end + 2).toString();
      const closing = suffix === '--' &&
        (end + 2 === buffer.length || buffer.subarray(end + 2, end + 4).toString() === '\r\n');
      if (lineStart && (suffix === '\r\n' || closing)) return index;
      index = buffer.indexOf(delimiter, index + delimiter.length);
    }
    return -1;
  };
  const parts = [];
  let cursor = findDelimiter(0);
  if (cursor < 0) throw new Error('boundary_not_found');
  cursor += delimiter.length;
  while (cursor < buffer.length) {
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) break;
    const headerText = buffer.slice(cursor, headerEnd).toString('utf8');
    const nextDelimiter = findDelimiter(headerEnd + 4);
    if (nextDelimiter < 0) break;
    let contentEnd = nextDelimiter;
    if (buffer.slice(contentEnd - 2, contentEnd).toString() === '\r\n') contentEnd -= 2;
    parts.push({ headerText, data: buffer.slice(headerEnd + 4, contentEnd) });
    cursor = nextDelimiter + delimiter.length;
  }
  for (const part of parts) {
    const nameMatch = /name="([^"]*)"/i.exec(part.headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(part.headerText);
    if (!fileMatch) continue;
    const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(part.headerText);
    return {
      field: nameMatch?.[1] ?? 'file',
      fileName: fileMatch[1],
      contentType: String(typeMatch?.[1] ?? 'application/octet-stream').trim().toLowerCase(),
      data: part.data
    };
  }
  return null;
}

/** 托管上传目录（仅允许已知图片扩展名，防目录穿越） */
function serveUpload(request, response, pathname, config) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }
  let relative;
  try {
    relative = decodeURIComponent(pathname.slice(UPLOAD_URL_PREFIX.length)).replace(/^\/+/, '');
  } catch {
    return sendJson(response, 400, { error: 'bad_path' });
  }
  if (!relative || relative.includes('..')) return sendJson(response, 404, { error: 'not_found' });
  const extension = extname(relative).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
    return sendJson(response, 404, { error: 'not_found' });
  }
  const filePath = resolve(config.uploadsDir, relative);
  if (filePath !== config.uploadsDir && !filePath.startsWith(config.uploadsDir + sep)) {
    return sendJson(response, 403, { error: 'forbidden' });
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(response, 404, { error: 'not_found' });
  }
  const stats = statSync(filePath);
  response.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': 'public, max-age=3600'
  });
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function serveStatic(request, response, pathname, config) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return sendJson(response, 400, { error: 'bad_path' });
  }
  let filePath = resolve(config.frontendDir, relative);
  if (filePath !== config.frontendDir && !filePath.startsWith(config.frontendDir + sep)) {
    return sendJson(response, 403, { error: 'forbidden' });
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(response, 404, { error: 'not_found', path: pathname });
  }
  const stats = statSync(filePath);
  const headers = {
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stats.size,
    // 本地联调阶段禁用缓存：改完代码刷新即生效（部署环境可换长缓存）
    'cache-control': 'no-store'
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!response.headersSent) sendJson(response, 500, { error: 'read_failed' });
    else response.destroy();
  });
  stream.pipe(response);
}

/* ============================================================================
 * 应用（请求处理）
 * ========================================================================== */

/**
 * 创建请求处理函数
 * @param {{ db:any, config:ReturnType<typeof parseEnvConfig>,
 *           fetchImpl?:typeof fetch, now?:() => number, logger?:Console,
 *           agentChatProvider?:(input:{messages:Array, agents:Array}) => any }} options
 */
export function createRequestHandler({ db, config, fetchImpl = fetch, now = Date.now, logger = console, agentChatProvider }) {
  /** 当前请求的登录用户（无会话返回 null） */
  async function currentUser(request) {
    const token = cookieValue(request, SESSION_COOKIE_NAME);
    if (!token) return null;
    const found = await db.findSessionUser(hashToken(token), now());
    return found ? found.user : null;
  }

  function publicUser(user) {
    return {
      ssoUid: user.sso_uid,
      name: user.name,
      displayName: user.display_name || user.name,
      role: user.role,
      orgName: user.org_name,
      isAdmin: computeIsAdmin(user, config)
    };
  }

  function sessionTokenOf(request) {
    return cookieValue(request, SESSION_COOKIE_NAME);
  }

  // 对外绝对地址基座：显式配置了 APP_PUBLIC_URL 用配置；否则按请求头动态推导（适配任意部署域名，零配置）
  function publicBase(request) {
    if (config.appPublicUrlExplicit) return config.appPublicUrl;
    return requestPublicOrigin(request) || config.appPublicUrl;
  }

  // return_to 白名单校验：静态白名单之外，始终放行本请求自身 origin（同源回跳天然可信）
  function resolveReturnToForRequest(returnTo, request) {
    const ownOrigin = safeOrigin(publicBase(request));
    const allowed = ownOrigin && !config.allowedReturnOrigins.includes(ownOrigin)
      ? [...config.allowedReturnOrigins, ownOrigin]
      : config.allowedReturnOrigins;
    return resolveReturnTo(returnTo, { ...config, allowedReturnOrigins: allowed });
  }

  async function handleStart(request, response, url) {
    const fail = (reason) => redirect(response, `${publicBase(request)}/?scene=last&login_error=${encodeURIComponent(reason)}`);
    if (!config.ssoCenterUrl) {
      logger.warn('[sso] SSO_CENTER_URL 未配置，无法发起登录');
      return fail('sso_not_configured');
    }
    const requested = url.searchParams.get('return_to');
    const resolved = resolveReturnToForRequest(requested, request);
    const returnTo = resolved ?? defaultCallbackUrl(publicBase(request));
    if (requested && !resolved) logger.warn('[sso] return_to 未命中白名单，已忽略:', requested);
    return redirect(response, buildSsoStartUrl({ ssoCenterUrl: config.ssoCenterUrl, returnTo }));
  }

  async function handleCallback(request, response, url) {
    const fail = (reason) => redirect(response, `${publicBase(request)}/?scene=last&login_error=${encodeURIComponent(reason)}`);
    const ticket = String(url.searchParams.get('ticket') ?? '').trim();
    if (!ticket) return fail('missing_ticket');
    if (!config.ssoCenterUrl || !config.ssoSharedSecret) {
      logger.error('[sso] SSO_CENTER_URL / SSO_SHARED_SECRET 未配置完整，无法验票');
      return fail('sso_not_configured');
    }

    const result = await verifySsoTicket({
      fetchImpl,
      ssoCenterUrl: config.ssoCenterUrl,
      secret: config.ssoSharedSecret,
      ticket
    });
    if (!result.ok) {
      const reason = mapVerifyFailure(result);
      logger.warn(`[sso] 验票失败 reason=${reason} status=${result.status} ticket=${ticket.slice(0, 6)}…`);
      return fail(reason);
    }

    const identity = normalizeIdentity(result.data);
    if (!identity) {
      logger.error('[sso] 身份字段缺失，keys=', result.data && typeof result.data === 'object' ? Object.keys(result.data).join(',') : typeof result.data);
      return fail('invalid_identity');
    }

    try {
      const timestamp = now();
      const isAdmin = isAdminIdentity(identity, config);
      const user = await db.upsertUserFromIdentity(identity, isAdmin, timestamp);
      const token = generateToken();
      await db.createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: timestamp + SESSION_TTL_MS,
        createdAt: timestamp
      });
      response.setHeader('Set-Cookie', serializeSessionCookie(token, SESSION_TTL_SECONDS, { secure: isSecureRequest(request) }));
      // 登录后按角色分流：管理员直达管理端（可新增智能体），普通用户直达查询平台
      const landing = isAdmin ? '/admin.html' : '/agents.html';
      logger.info(`[sso] 登录成功 uid=${identity.ssoUid} isAdmin=${isAdmin} → ${landing}`);
      return redirect(response, `${publicBase(request)}${landing}?login=ok`);
    } catch (error) {
      logger.error('[sso] 建立会话失败:', error);
      return fail('session_failed');
    }
  }

  async function handleMe(request, response) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 200, { user: null, ssoEnabled: Boolean(config.ssoCenterUrl) });
    const isAdmin = computeIsAdmin(user, config);
    if ((user.is_admin ? 1 : 0) !== (isAdmin ? 1 : 0)) await db.updateAdminFlag(user.id, isAdmin, now());
    return sendJson(response, 200, { user: publicUser(user), ssoEnabled: Boolean(config.ssoCenterUrl) });
  }

  async function handleLogout(request, response) {
    const token = sessionTokenOf(request);
    if (token) await db.deleteSession(hashToken(token));
    response.setHeader('Set-Cookie', serializeSessionCookie('', 0, { secure: isSecureRequest(request) }));
    const returnTo = `${publicBase(request)}/?scene=last&logout=1`;
    return sendJson(response, 200, {
      ok: true,
      logoutUrl: buildSsoLogoutUrl({ ssoCenterUrl: config.ssoCenterUrl, returnTo })
    });
  }

  async function handleCardEffectSettings(request, response) {
    const saved = await db.cardEffectSettings();
    return sendJson(response, 200, {
      settings: normalizeCardEffectSettings(saved?.settings ?? DEFAULT_CARD_EFFECT_SETTINGS),
      updatedAt: saved?.updatedAt ?? null
    });
  }

  async function handleSaveCardEffectSettings(request, response) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });
    const origin = request.headers.origin;
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    if ((origin !== undefined && safeOrigin(origin) !== safeOrigin(publicBase(request)))
      || fetchSite === 'cross-site' || fetchSite === 'same-site') {
      return sendJson(response, 403, { error: 'cross_origin_forbidden' });
    }
    const body = await readAgentPayload(request, response);
    if (!body) return;
    const settings = body.settings;
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'settings')
      || settings === null || typeof settings !== 'object' || Array.isArray(settings)
      || Object.keys(settings).length !== CARD_EFFECT_FIELDS.length
      || !CARD_EFFECT_FIELDS.every((field) => {
        if (!Object.hasOwn(settings, field.key)) return false;
        const value = settings[field.key];
        return field.type === 'color'
          ? typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
          : typeof value === 'number' && Number.isFinite(value) && value >= field.min && value <= field.max;
      })) {
      return sendJson(response, 400, { error: 'invalid_card_effect_settings' });
    }
    const saved = await db.saveCardEffectSettings(normalizeCardEffectSettings(settings), now());
    return sendJson(response, 200, saved);
  }

  async function featuredAgentsPayload(settings = null) {
    const saved = settings ?? await db.featuredAgentSettings();
    const agentIds = [...saved.agentIds];
    const items = [];
    for (let index = 0; index < agentIds.length; index += 1) {
      const agentId = agentIds[index];
      if (!agentId) continue;
      const row = await db.findAgentById(agentId);
      if (!row) {
        agentIds[index] = null;
        continue;
      }
      const stats = await db.agentViewStats(agentId);
      items.push({ ...agentSummary(row), position: index + 1, viewStats: { viewCount: stats.viewCount } });
    }
    return {
      configured: saved.updatedAt !== null,
      agentIds,
      items,
      updatedAt: saved.updatedAt
    };
  }

  async function handleFeaturedAgents(request, response) {
    return sendJson(response, 200, await featuredAgentsPayload());
  }

  async function handleSaveFeaturedAgents(request, response) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });
    const origin = request.headers.origin;
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    if ((origin !== undefined && safeOrigin(origin) !== safeOrigin(publicBase(request)))
      || fetchSite === 'cross-site' || fetchSite === 'same-site') {
      return sendJson(response, 403, { error: 'cross_origin_forbidden' });
    }
    const body = await readAgentPayload(request, response);
    if (!body) return;
    if (Object.keys(body).length !== 1 || !Array.isArray(body.agentIds) || body.agentIds.length !== 3) {
      return sendJson(response, 400, { error: 'invalid_featured_agent_ids' });
    }
    const agentIds = body.agentIds.map((value) => typeof value === 'string' ? value.trim() : value);
    if (agentIds.some((value) => value !== null && (typeof value !== 'string' || !value))
      || new Set(agentIds.filter(Boolean)).size !== agentIds.filter(Boolean).length) {
      return sendJson(response, 400, { error: 'invalid_featured_agent_ids' });
    }
    for (const agentId of agentIds) {
      if (agentId && !(await db.findAgentById(agentId))) {
        return sendJson(response, 400, { error: 'featured_agent_not_found', agentId });
      }
    }
    const saved = await db.saveFeaturedAgentSettings(agentIds, now());
    return sendJson(response, 200, await featuredAgentsPayload(saved));
  }

  async function handleListAgents(request, response, url) {
    const keyword = url.searchParams.get('q') ?? '';
    const discipline = url.searchParams.get('discipline') ?? '';
    const school = url.searchParams.get('school') ?? '';
    const status = url.searchParams.get('status') ?? '';
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
    const { items, total } = await db.listAgents({ query: keyword, discipline, school, status, limit, offset });
    const user = await currentUser(request);
    const isAdmin = user && computeIsAdmin(user, config);
    const viewStats = await db.agentViewStatsForAgents(items.map((item) => item.id));
    return sendJson(response, 200, {
      items: items.map((row) => {
        const stats = viewStats.get(row.id);
        return { ...agentSummary(row), viewStats: isAdmin ? stats : { viewCount: stats.viewCount } };
      }),
      total,
      query: String(keyword).trim(),
      discipline: String(discipline).trim(),
      school: String(school).trim(),
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
      offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0
    });
  }

  async function handleAgentStats(request, response) {
    return sendJson(response, 200, await db.agentStats());
  }

  async function handleAgentDetail(request, response, agentId) {
    const row = await db.findAgentById(agentId);
    if (!row) return sendJson(response, 404, { error: 'agent_not_found' });
    return sendJson(response, 200, { item: agentDetail(row) });
  }

  /** AI 接入点：默认不配置 provider，不以本地搜索冒充模型回复。 */
  async function handleAgentChat(request, response) {
    const origin = request.headers.origin;
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    if ((origin !== undefined && safeOrigin(origin) !== safeOrigin(publicBase(request)))
      || fetchSite === 'cross-site' || fetchSite === 'same-site') {
      request.resume();
      return sendJson(response, 403, { error: 'cross_origin_forbidden' });
    }
    const body = await readAgentPayload(request, response);
    if (!body) return;
    const messages = normalizeAgentChatMessages(body.messages);
    if (!messages) return sendJson(response, 400, { error: 'invalid_messages' });
    if (typeof agentChatProvider !== 'function') return sendJson(response, 503, { error: 'ai_not_configured' });

    // 当前候选范围为按现有列表排序的前 500 条启用案例；读取完整公开详情，不含访客或登录身份。
    const agentRows = (await db.listAgents({ status: 'active', limit: 500 })).items;
    const agents = [];
    for (const row of agentRows) agents.push(agentDetail(await db.findAgentById(row.id)));
    const candidateIds = new Set(agents.map((item) => item.id));
    try {
      const result = await agentChatProvider({ messages, agents });
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || typeof result.reply !== 'string' || !result.reply.trim()
        || !Array.isArray(result.agentIds) || !result.agentIds.every((id) => typeof id === 'string')
        || (Object.hasOwn(result, 'recommendations') && (!Array.isArray(result.recommendations)
          || !result.recommendations.every((item) => item && typeof item === 'object' && !Array.isArray(item)
            && typeof item.id === 'string' && item.id.trim()
            && Number.isInteger(item.matchScore) && item.matchScore >= 0 && item.matchScore <= 100
            && typeof item.matchReason === 'string' && item.matchReason.trim()
            && item.matchReason.trim().length <= 300)))) {
        return sendJson(response, 502, { error: 'ai_unavailable' });
      }
      const recommendations = new Map();
      for (const item of result.recommendations ?? []) {
        if (!recommendations.has(item.id)) recommendations.set(item.id, {
          matchScore: item.matchScore, matchReason: item.matchReason.trim()
        });
      }
      if (Object.hasOwn(result, 'recommendations')
        && result.agentIds.some((id) => candidateIds.has(id) && !recommendations.has(id))) {
        return sendJson(response, 502, { error: 'ai_unavailable' });
      }
      const items = [];
      for (const id of new Set(result.agentIds)) {
        if (!candidateIds.has(id)) continue;
        const row = await db.findAgentById(id);
        if (row?.status === 'active') items.push({ ...agentSummary(row), ...recommendations.get(id) });
      }
      items.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
      return sendJson(response, 200, { reply: result.reply.trim(), items: items.slice(0, 5) });
    } catch {
      logger.warn('[agent-chat] AI 响应失败');
      return sendJson(response, 502, { error: 'ai_unavailable' });
    }
  }

  /** 前台详情打开后显式记一次浏览；管理员维护与详情读取本身不计数。 */
  async function handleRecordAgentView(request, response, agentId) {
    request.resume(); // 不读取客户端身份字段，只消费并丢弃请求体。
    if (!(await db.findAgentById(agentId))) return sendJson(response, 404, { error: 'agent_not_found' });
    const origin = request.headers.origin;
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    if ((origin !== undefined && safeOrigin(origin) !== safeOrigin(publicBase(request)))
      || fetchSite === 'cross-site' || fetchSite === 'same-site') {
      return sendJson(response, 403, { error: 'cross_origin_forbidden' });
    }
    const user = await currentUser(request);
    if (user && computeIsAdmin(user, config)) return sendJson(response, 200, { ok: true, recorded: false });

    let visitorKey;
    if (user) {
      visitorKey = `u:${user.id}`;
    } else {
      let token = cookieValue(request, VISITOR_COOKIE_NAME);
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        token = generateToken();
        response.setHeader('Set-Cookie', serializeVisitorCookie(token, { secure: isSecureRequest(request) }));
      }
      visitorKey = `a:${hashToken(token)}`;
    }
    await db.recordAgentView({ agentId, visitorKey, userId: user?.id ?? null, timestamp: now() });
    return sendJson(response, 200, { ok: true, recorded: true });
  }

  async function handleAgentViews(request, response, url, agentId) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });
    if (!(await db.findAgentById(agentId))) return sendJson(response, 404, { error: 'agent_not_found' });
    const page = await db.listAgentViews(agentId, {
      limit: url.searchParams.get('limit') ?? 50,
      offset: url.searchParams.get('offset') ?? 0
    });
    const viewStats = await db.agentViewStats(agentId);
    return sendJson(response, 200, { viewStats, ...page });
  }

  /** 读取并校验请求体为对象（读失败直接回响应并返回 null） */
  async function readAgentPayload(request, response) {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const code = error?.code === 'payload_too_large' ? 'payload_too_large' : 'invalid_json';
      sendJson(response, code === 'payload_too_large' ? 413 : 400, { error: code });
      return null;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: 'invalid_json' });
      return null;
    }
    return body;
  }

  async function handleCreateAgent(request, response) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });

    const body = await readAgentPayload(request, response);
    if (!body) return;

    const parsed = normalizeAgentInput(body);
    if (!parsed.ok) return sendJson(response, 400, { error: parsed.error });
    const input = parsed.value;

    const timestamp = now();
    const record = {
      id: `agent_${timestamp}_${randomUUID().slice(0, 8)}`,
      name: input.name,
      summary: input.summary ?? '',
      tags: input.tags ?? '',
      status: input.status ?? 'active',
      dataJson: input.dataJson ?? '{}',
      discipline: input.discipline ?? '',
      major: input.major ?? '',
      courseName: input.courseName ?? '',
      agentUrl: input.agentUrl ?? '',
      schoolName: input.schoolName ?? '',
      coverImage: input.coverImage ?? '',
      painPoint: input.painPoint ?? '',
      usageGuide: input.usageGuide ?? '',
      createdBy: user.id,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    try {
      const row = await db.insertAgent(record);
      logger.info(`[agents] 新增 uid=${user.sso_uid} id=${row.id}`);
      return sendJson(response, 201, { item: agentDetail(row) });
    } catch (error) {
      logger.error('[agents] 新增失败:', error);
      return sendJson(response, 500, { error: 'agent_create_failed' });
    }
  }

  /** 更新：未提供的字段保留原值（合并后整行写回） */
  async function handleUpdateAgent(request, response, agentId) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });

    const existing = await db.findAgentById(agentId);
    if (!existing) return sendJson(response, 404, { error: 'agent_not_found' });

    const body = await readAgentPayload(request, response);
    if (!body) return;

    const parsed = normalizeAgentInput(body, { partial: true });
    if (!parsed.ok) return sendJson(response, 400, { error: parsed.error });
    const input = parsed.value;

    const record = {
      id: existing.id,
      name: input.name ?? existing.name,
      summary: input.summary ?? existing.summary,
      tags: input.tags ?? existing.tags,
      status: input.status ?? existing.status,
      dataJson: input.dataJson ?? existing.data_json,
      discipline: input.discipline ?? existing.discipline,
      major: input.major ?? existing.major,
      courseName: input.courseName ?? existing.course_name,
      agentUrl: input.agentUrl ?? existing.agent_url,
      schoolName: input.schoolName ?? existing.school_name,
      coverImage: input.coverImage ?? existing.cover_image,
      painPoint: input.painPoint ?? existing.pain_point,
      usageGuide: input.usageGuide ?? existing.usage_guide,
      updatedAt: now()
    };
    try {
      const row = await db.updateAgent(record);
      logger.info(`[agents] 更新 uid=${user.sso_uid} id=${row.id}`);
      // 封面被替换时回收旧文件（仍被其他记录引用则保留）
      if (existing.cover_image && existing.cover_image !== row.cover_image) {
        await removeUploadIfUnused(existing.cover_image);
      }
      return sendJson(response, 200, { item: agentDetail(row) });
    } catch (error) {
      logger.error('[agents] 更新失败:', error);
      return sendJson(response, 500, { error: 'agent_update_failed' });
    }
  }

  async function handleDeleteAgent(request, response, agentId) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });

    const existing = await db.findAgentById(agentId);
    if (!existing) return sendJson(response, 404, { error: 'agent_not_found' });

    try {
      await db.deleteAgent(agentId);
      logger.info(`[agents] 删除 uid=${user.sso_uid} id=${agentId}`);
      if (existing.cover_image) await removeUploadIfUnused(existing.cover_image);
      return sendJson(response, 200, { ok: true, id: agentId });
    } catch (error) {
      logger.error('[agents] 删除失败:', error);
      return sendJson(response, 500, { error: 'agent_delete_failed' });
    }
  }

  /** 删除不再被引用的站内封面文件（外链忽略；失败仅告警） */
  async function removeUploadIfUnused(coverImage) {
    if (!coverImage || !coverImage.startsWith(UPLOAD_URL_PREFIX)) return;
    if (await db.isCoverInUse(coverImage)) return;
    const relative = coverImage.slice(UPLOAD_URL_PREFIX.length);
    const filePath = resolve(config.uploadsDir, relative);
    if (filePath !== config.uploadsDir && !filePath.startsWith(config.uploadsDir + sep)) return;
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (error) {
      logger.warn(`[uploads] 旧封面清理失败 ${coverImage}:`, error?.message ?? error);
    }
  }

  /** 上传封面（multipart/form-data，单文件字段名 file） */
  async function handleUploadCover(request, response) {
    const user = await currentUser(request);
    if (!user) return sendJson(response, 401, { error: 'authentication_required' });
    if (!computeIsAdmin(user, config)) return sendJson(response, 403, { error: 'admin_required' });

    const contentType = String(request.headers['content-type'] ?? '');
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!contentType.toLowerCase().startsWith('multipart/form-data') || !boundaryMatch) {
      return sendJson(response, 400, { error: 'multipart_required' });
    }

    let buffer;
    try {
      buffer = await readRawBody(request, MAX_UPLOAD_BYTES + 8 * 1024);
    } catch (error) {
      const tooLarge = error?.code === 'payload_too_large';
      return sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'file_too_large' : 'invalid_upload' });
    }

    const boundary = boundaryMatch[1] ?? boundaryMatch[2];
    let file;
    try {
      file = extractUploadFile(buffer, boundary);
    } catch {
      return sendJson(response, 400, { error: 'invalid_upload' });
    }
    if (!file) return sendJson(response, 400, { error: 'file_required' });

    const extension = COVER_MIME_EXTENSIONS[file.contentType];
    if (!extension) return sendJson(response, 415, { error: 'unsupported_image_type' });
    if (file.data.length > MAX_UPLOAD_BYTES) return sendJson(response, 413, { error: 'file_too_large' });
    if (!file.data.length) return sendJson(response, 400, { error: 'empty_file' });

    // 内容校验：文件头必须真的是图片；落盘扩展名以实际内容为准（不信任客户端声明的 MIME）
    const sniffedMime = sniffImageMime(file.data);
    const sniffedExtension = COVER_MIME_EXTENSIONS[sniffedMime];
    if (!sniffedExtension) return sendJson(response, 400, { error: 'invalid_image_data' });

    try {
      mkdirSync(config.uploadsDir, { recursive: true });
      const fileName = `${Date.now()}_${randomUUID().slice(0, 8)}${sniffedExtension}`;
      writeFileSync(join(config.uploadsDir, fileName), file.data);
      logger.info(`[uploads] 封面已保存 uid=${user.sso_uid} file=${fileName} type=${sniffedMime}`);
      return sendJson(response, 201, { url: `${UPLOAD_URL_PREFIX}${fileName}` });
    } catch (error) {
      logger.error('[uploads] 保存失败:', error);
      return sendJson(response, 500, { error: 'upload_failed' });
    }
  }

  return async function handler(request, response) {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = requestUrl.pathname;
    const method = request.method ?? 'GET';
    try {
      if (pathname === '/api/health') {
        if (method !== 'GET') return sendJson(response, 405, { error: 'method_not_allowed' });
        return sendJson(response, 200, { ok: true, service: 'agent-official-website-backend', time: now() });
      }
      if (pathname === '/api/auth/me') {
        if (method !== 'GET') return sendJson(response, 405, { error: 'method_not_allowed' });
        return await handleMe(request, response);
      }
      if (pathname === '/api/auth/chaoxing/start' || pathname === '/api/auth/sso/start') {
        if (method !== 'GET') return sendJson(response, 405, { error: 'method_not_allowed' });
        return handleStart(request, response, requestUrl);
      }
      if (pathname === '/api/auth/chaoxing/callback' || pathname === '/api/auth/sso/callback') {
        if (method !== 'GET') return sendJson(response, 405, { error: 'method_not_allowed' });
        return await handleCallback(request, response, requestUrl);
      }
      if (pathname === '/api/auth/logout') {
        if (method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
        return await handleLogout(request, response);
      }
      if (pathname === '/api/card-effects') {
        if (method === 'GET') return await handleCardEffectSettings(request, response);
        if (method === 'PUT') return await handleSaveCardEffectSettings(request, response);
        response.setHeader('Allow', 'GET, PUT');
        return sendJson(response, 405, { error: 'method_not_allowed' });
      }
      if (pathname === '/api/featured-agents') {
        if (method === 'GET') return await handleFeaturedAgents(request, response);
        if (method === 'POST') return await handleSaveFeaturedAgents(request, response);
        response.setHeader('Allow', 'GET, POST');
        return sendJson(response, 405, { error: 'method_not_allowed' });
      }
      if (pathname === '/api/agents') {
        if (method === 'GET') return await handleListAgents(request, response, requestUrl);
        if (method === 'POST') return await handleCreateAgent(request, response);
        return sendJson(response, 405, { error: 'method_not_allowed' });
      }
      if (pathname === '/api/agents/stats') {
        if (method !== 'GET') return sendJson(response, 405, { error: 'method_not_allowed' });
        return await handleAgentStats(request, response);
      }
      if (pathname === '/api/agents/chat') {
        if (method !== 'POST') {
          response.setHeader('Allow', 'POST');
          return sendJson(response, 405, { error: 'method_not_allowed' });
        }
        return await handleAgentChat(request, response);
      }
      if (pathname === '/api/uploads') {
        if (method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
        return await handleUploadCover(request, response);
      }
      const agentViewsMatch = /^\/api\/agents\/([^/]+)\/views$/.exec(pathname);
      if (agentViewsMatch) {
        let agentId;
        try {
          agentId = decodeURIComponent(agentViewsMatch[1]);
        } catch {
          return sendJson(response, 400, { error: 'bad_path' });
        }
        if (method === 'POST') return await handleRecordAgentView(request, response, agentId);
        if (method === 'GET') return await handleAgentViews(request, response, requestUrl, agentId);
        return sendJson(response, 405, { error: 'method_not_allowed' });
      }
      const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(pathname);
      if (agentMatch) {
        let agentId;
        try {
          agentId = decodeURIComponent(agentMatch[1]);
        } catch {
          return sendJson(response, 400, { error: 'bad_path' });
        }
        if (method === 'GET') return await handleAgentDetail(request, response, agentId);
        if (method === 'PUT' || method === 'PATCH') return await handleUpdateAgent(request, response, agentId);
        if (method === 'DELETE') return await handleDeleteAgent(request, response, agentId);
        return sendJson(response, 405, { error: 'method_not_allowed' });
      }
      if (pathname.startsWith(UPLOAD_URL_PREFIX)) {
        return serveUpload(request, response, pathname, config);
      }
      if (pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'not_found', path: pathname });
      return serveStatic(request, response, pathname, config);
    } catch (error) {
      logger.error('[server] 未捕获异常:', error);
      if (!response.headersSent) return sendJson(response, 500, { error: 'server_error' });
      response.destroy();
    }
  };
}

/** 列表摘要（含查询页展示所需字段；长文本 painPoint / usageGuide 只在详情返回） */
export function agentSummary(row) {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    tags: row.tags,
    status: row.status,
    discipline: row.discipline,
    major: row.major,
    courseName: row.course_name,
    agentUrl: row.agent_url,
    schoolName: row.school_name,
    coverImage: row.cover_image,
    updatedAt: row.updated_at
  };
}

/** 详情（解析扩展字段；解析失败置空对象，不阻断接口） */
export function agentDetail(row) {
  let data = {};
  try {
    data = JSON.parse(row.data_json || '{}');
  } catch {
    data = {};
  }
  return {
    ...agentSummary(row),
    painPoint: row.pain_point,
    usageGuide: row.usage_guide,
    data,
    createdAt: row.created_at
  };
}

/* ============================================================================
 * 启动入口
 * ========================================================================== */

/**
 * 启动后端服务（供 .preview-server.js 与测试脚本调用）
 * @returns {{ server:import('node:http').Server, config:any, db:any }}
 */
export async function startPreviewServer(overrides = {}, { logger = console, agentChatProvider } = {}) {
  const config = parseEnvConfig(process.env, overrides);

  // 持久化选择：配置了 DATABASE_URL(postgresql://) 走 PostgreSQL；否则用本地 SQLite。
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL ?? process.env.SUPABASE_DATABASE_URL ?? '';
  let db;
  let dbLabel;
  if (databaseUrl.startsWith('postgresql://') || databaseUrl.startsWith('postgres://')) {
    db = await createPgStorage({ connectionString: databaseUrl });
    dbLabel = `PostgreSQL ${maskPgUrl(databaseUrl)}`;
  } else {
    db = createDatabase({ databasePath: config.dbPath });
    await db.purgeExpiredSessions(Date.now());
    dbLabel = `SQLite ${config.dbPath}`;
  }

  const server = createServer(createRequestHandler({ db, config, logger, agentChatProvider }));

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      logger.info('──────────────────────────────────────────────');
      logger.info(`  站点入口    http://${config.host}:${config.port}/`);
      logger.info(`  智能体平台  http://${config.host}:${config.port}/agents.html`);
      logger.info(`  管理端      http://${config.host}:${config.port}/admin.html`);
      logger.info(`  回调地址    ${defaultCallbackUrl(config.appPublicUrl)}`);
      logger.info(`  认证中心    ${config.ssoCenterUrl || '（未配置 SSO_CENTER_URL）'}`);
      logger.info(`  密钥        ${config.ssoSharedSecret ? `已配置（${config.ssoSharedSecret.length} 字符）` : '（未配置 SSO_SHARED_SECRET）'}`);
      logger.info(`  数据库      ${dbLabel}`);
      logger.info(`  封面上传    ${config.uploadsDir}`);
      logger.info(`  白名单      ${config.allowedReturnOrigins.join(', ') || '（无）'}`);
      logger.info('──────────────────────────────────────────────');
      resolveListen();
    });
  });

  const shutdown = () => {
    server.close(() => {
      Promise.resolve(db.close()).finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, config, db };
}

/** 日志中遮蔽 PG 连接串里的密码 */
function maskPgUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return 'PostgreSQL';
  }
}

/** 直接执行（node project/backend/server.mjs）时启动服务 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startPreviewServer().catch((err) => {
    console.error('服务启动失败：', err);
    process.exit(1);
  });
}
