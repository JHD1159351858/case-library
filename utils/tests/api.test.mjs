/**
 * 接口测试：后端服务全链路（node --test，零依赖）
 *
 * 测试策略：
 *   - 起两个真实 HTTP 服务：本站后端（临时端口 + 临时数据库）与模拟认证中心
 *   - 模拟认证中心实现最小契约：
 *       GET  /api/auth/chaoxing?return_to=...   发放一次性 ticket 并回跳
 *       POST /api/sso/verify                    按 ticket / secret 返回身份或错误码
 *       GET  /api/auth/logout                   回跳 return_to（契约同真实中心）
 *   - 手动跟随重定向，完整模拟浏览器 SSO 往返
 *
 * 请求工具使用 node:http 且关闭连接复用（agent:false），避免 keep-alive
 * 连接挂住 server.close() 导致的测试不退出。
 *
 * 覆盖：
 *   - 健康检查 / 会话状态 / 静态资源 / 路径穿越防护
 *   - SSO 全链路：发起 → 验票 → 建会话 → Cookie → me → 登出
 *   - 票据一次性（复用 → ticket_used）、密钥不匹配（invalid_secret）、票据不存在
 *   - return_to 白名单：非白名单忽略且不影响登录
 *   - 权限边界：未登录 401 / 非管理员 403 / 管理员 201
 *   - 输入校验：缺名称 400、非法 JSON 400、超长 400
 *   - 检索与详情接口、LIKE 通配符转义、方法限制
 *   - 封面上传：multipart 解析、内容魔数校验、10 MB 上限（413 响应可读）、封面替换回收
 *   - 字段完整性：新增后列表 / 详情返回全部已填写字段，链接字段校验与安全属性
 *   - 浏览统计：身份去重、管理员排除、明细权限 / 隐私、分页、来源校验与删除回收
 *
 * 运行：node --test "utils/tests/*.test.mjs"
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { startPreviewServer } from '../../project/backend/server.mjs';
import { CARD_EFFECT_FIELDS, DEFAULT_CARD_EFFECT_SETTINGS } from '../../project/frontend/js/card-effect-settings.js';

const ADMIN_ROLES = 'admin,ops';
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

/* ---------------- 请求工具（不复用连接） ---------------- */

/**
 * 发起 HTTP 请求并读取完整响应体
 * @returns {Promise<{ status:number, headers:Record<string,string>, text:string, bytes:Buffer,
 *                     location:string|null, cookie:string|null, setCookies:string[] }>}
 */
function request(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
          connection: 'close'
        },
        agent: false
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const setCookies = res.headers['set-cookie'] ?? [];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: bytes.toString('utf8'),
            // 二进制响应（图片上传回读）必须按字节比较，不能用 utf8 文本
            bytes,
            location: res.headers.location ?? null,
            setCookies,
            cookie: pickSessionCookie(setCookies)
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${method} ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** 取有效的会话 Cookie（忽略 Max-Age=0 的清除指令） */
function pickSessionCookie(setCookies) {
  const raw = setCookies.find(
    (item) => item.startsWith('agent_site_session=') && !item.includes('Max-Age=0')
  );
  return raw ? raw.split(';')[0] : null;
}

async function getJson(url, options) {
  const response = await request(url, options);
  let parsed = null;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    parsed = null;
  }
  return { ...response, body: parsed };
}

/* ---------------- 测试基础设施 ---------------- */

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 模拟认证中心：最小 SSO 契约 */
function startFakeCenter({ secret }) {
  const tickets = new Map();
  const used = new Set();
  const identities = {
    admin: { uid: 'u-admin', name: 'adminuser', displayName: '管理员甲', fid: '1001', orgName: '测试机构', roles: [{ roleId: 'r1', roleName: 'admin' }] },
    student: { uid: 'u-student', name: 'studentuser', displayName: '学生乙', fid: '1002', orgName: '测试机构', roles: [{ roleId: 'r2', roleName: 'student' }] },
    uidadmin: { uid: 'u-admin2', name: 'secondadmin', displayName: '管理员丙', fid: '1003', orgName: '测试机构', roles: [] }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const replyJson = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && url.pathname === '/api/auth/chaoxing') {
      const returnTo = url.searchParams.get('return_to');
      if (!returnTo) return replyJson(400, { error: 'missing_return_to' });
      const as = url.searchParams.get('as') ?? 'student';
      const ticket = `ticket_${tickets.size + 1}_${Math.random().toString(36).slice(2, 8)}`;
      tickets.set(ticket, identities[as] ?? identities.student);
      const location = new URL(returnTo);
      location.searchParams.set('ticket', ticket);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sso/verify') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = {};
        }
        if (payload.secret !== secret) return replyJson(401, { error: 'invalid_secret' });
        if (used.has(payload.ticket)) return replyJson(410, { error: 'ticket_used' });
        const identity = tickets.get(payload.ticket);
        if (!identity) return replyJson(400, { error: 'invalid_ticket' });
        used.add(payload.ticket);
        return replyJson(200, identity);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/logout') {
      res.writeHead(302, { location: url.searchParams.get('return_to') ?? '/' });
      res.end();
      return;
    }

    replyJson(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 启动整套环境（本站后端 + 模拟中心 + 临时库），结束后强制关闭所有连接 */
async function withEnvironment(run, { ssoSecret = 'test-secret-0123456789', centerSecret, agentChatProvider } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-site-api-'));
  const sitePort = await getFreePort();
  const center = await startFakeCenter({ secret: centerSecret ?? ssoSecret });
  const site = await startPreviewServer(
    {
      port: sitePort,
      host: '127.0.0.1',
      appPublicUrl: `http://127.0.0.1:${sitePort}`,
      ssoCenterUrl: `http://127.0.0.1:${center.port}`,
      ssoSharedSecret: ssoSecret,
      returnOrigins: `http://127.0.0.1:${sitePort}`,
      adminRoles: ADMIN_ROLES,
      adminSsoUids: 'u-admin2',
      dbPath: join(dir, 'api-test.db'),
      // 封面上传落到临时目录，测试不得污染 database/uploads
      uploadsDir: join(dir, 'uploads')
    },
    { logger: SILENT_LOGGER, agentChatProvider }
  );

  await new Promise((resolve, reject) => {
    if (site.server.listening) return resolve();
    site.server.once('listening', resolve);
    site.server.once('error', reject);
  });

  const base = `http://127.0.0.1:${sitePort}`;
  try {
    return await run({ base, center, site });
  } finally {
    site.server.closeAllConnections?.();
    await new Promise((resolve) => site.server.close(resolve));
    site.db.close();
    center.server.closeAllConnections?.();
    await new Promise((resolve) => center.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 完整走一遍 SSO：start → 中心授权 → 回调 → 返回登录后的会话 Cookie */
async function login({ base, center }, as = 'admin', { returnTo } = {}) {
  const callback = `${base}/api/auth/chaoxing/callback`;
  const startUrl = `${base}/api/auth/chaoxing/start?return_to=${encodeURIComponent(returnTo ?? callback)}`;

  const startResponse = await request(startUrl);
  assert.equal(startResponse.status, 302, 'start 应 302 到认证中心');
  const centerAuthUrl = new URL(startResponse.location);
  assert.equal(centerAuthUrl.origin, `http://127.0.0.1:${center.port}`);
  assert.equal(centerAuthUrl.pathname, '/api/auth/chaoxing');

  // 模拟中心侧发起授权（as 为测试便利参数；真实中心没有该参数）
  centerAuthUrl.searchParams.set('as', as);
  const centerResponse = await request(centerAuthUrl.toString());
  assert.equal(centerResponse.status, 302, '认证中心应 302 回本站回调');
  const callbackUrl = new URL(centerResponse.location);
  assert.equal(callbackUrl.origin, base);
  assert.equal(callbackUrl.pathname, '/api/auth/chaoxing/callback');
  assert.ok(callbackUrl.searchParams.get('ticket'), '回调必须携带 ticket');

  const finalResponse = await request(callbackUrl.toString());
  assert.equal(finalResponse.status, 302, '回调应 302 回站点');
  return { finalResponse, cookie: finalResponse.cookie, callbackUrl, centerResponse };
}

/* ---------------- 用例 ---------------- */

test('健康检查与会话初始状态', async () => {
  await withEnvironment(async ({ base }) => {
    const health = await getJson(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const me = await getJson(`${base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null);
    assert.equal(me.body.ssoEnabled, true);
  });
});

test('静态资源：首页 / 查询平台 / 管理端均可达', async () => {
  await withEnvironment(async ({ base }) => {
    for (const path of [
      '/',
      '/agents.html',
      '/admin.html',
      '/app.css',
      '/site-ui.css',
      '/js/site-ui.js',
      '/js/agents.js',
      '/js/admin.js',
      '/js/session.js'
    ]) {
      const response = await request(`${base}${path}`);
      assert.equal(response.status, 200, `${path} 应可访问`);
    }
    const html = (await request(`${base}/`)).text;
    assert.ok(html.includes('Skip Intro'), '首页应包含直达最后一幕按钮');
    assert.ok(html.includes('finale-login'), '首页最后一幕应包含登录入口');
  });
});

test('安全：目录穿越与未知接口返回错误且不泄漏文件', async () => {
  await withEnvironment(async ({ base }) => {
    const traversal = await request(`${base}/%2e%2e/%2e%2e/.env`);
    assert.ok([400, 403, 404].includes(traversal.status), `穿越请求应被拒绝，实际 ${traversal.status}`);
    assert.ok(!traversal.text.includes('SSO_SHARED_SECRET'), '不得泄漏配置内容');

    const unknown = await getJson(`${base}/api/does-not-exist`);
    assert.equal(unknown.status, 404);
  });
});

test('SSO 全链路：管理员登录 → 分流到管理端 → me 返回管理员身份', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { finalResponse, cookie } = await login({ base, center }, 'admin');
    // 角色分流：管理员登录后直达管理端（可上传智能体）
    assert.equal(new URL(finalResponse.location).pathname, '/admin.html', `管理员应分流到管理端，实际 ${finalResponse.location}`);
    assert.ok(finalResponse.location.includes('login=ok'));
    assert.ok(cookie, '应种会话 Cookie');
    assert.ok(
      finalResponse.setCookies.some((item) => item.includes('HttpOnly') && item.includes('SameSite=Lax')),
      '会话 Cookie 必须具备 HttpOnly + SameSite'
    );

    const me = await getJson(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.ssoUid, 'u-admin');
    assert.equal(me.body.user.displayName, '管理员甲');
    assert.equal(me.body.user.isAdmin, true, 'role=admin 应判定为管理员');
  });
});

test('SSO 全链路：普通用户登录 → 分流到查询平台', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { finalResponse, cookie } = await login({ base, center }, 'student');
    assert.equal(new URL(finalResponse.location).pathname, '/agents.html', `普通用户应分流到查询平台，实际 ${finalResponse.location}`);
    assert.ok(finalResponse.location.includes('login=ok'));
    assert.ok(cookie, '应种会话 Cookie');

    const me = await getJson(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.isAdmin, false);
  });
});

test('SSO 全链路：ADMIN_SSO_UIDS 兜底使无角色用户成为管理员', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { finalResponse, cookie } = await login({ base, center }, 'uidadmin');
    assert.equal(new URL(finalResponse.location).pathname, '/admin.html', '白名单 uid 应分流到管理端');
    const me = await getJson(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.body.user.isAdmin, true, 'ADMIN_SSO_UIDS 名单内应判定为管理员');
  });
});

test('SSO：非管理员登录后 isAdmin=false，且写接口 403', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'student');
    const me = await getJson(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.body.user.isAdmin, false);

    const created = await getJson(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '越权尝试' })
    });
    assert.equal(created.status, 403);
    assert.equal(created.body.error, 'admin_required');
  });
});

test('SSO：票据一次性，复用返回 ticket_used 且不建立会话', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { callbackUrl } = await login({ base, center }, 'student');
    const reuse = await request(callbackUrl.toString());
    assert.equal(reuse.status, 302);
    assert.ok(reuse.location.includes('login_error=ticket_used'), `应提示票据已用，实际 ${reuse.location}`);
    assert.equal(reuse.cookie, null, '复用票据不得建立会话');
  });
});

test('SSO：密钥不匹配返回 invalid_secret 错误码', async () => {
  await withEnvironment(
    async ({ base, center }) => {
      const { finalResponse } = await login({ base, center }, 'admin');
      assert.ok(finalResponse.location.includes('login_error=invalid_secret'));
    },
    { ssoSecret: 'site-secret', centerSecret: 'different-secret' }
  );
});

test('SSO：缺失 ticket 提示 missing_ticket', async () => {
  await withEnvironment(async ({ base }) => {
    const response = await request(`${base}/api/auth/chaoxing/callback`);
    assert.equal(response.status, 302);
    assert.ok(response.location.includes('login_error=missing_ticket'));
  });
});

test('SSO：未知票据返回 invalid_ticket', async () => {
  await withEnvironment(async ({ base }) => {
    const response = await request(`${base}/api/auth/chaoxing/callback?ticket=never-issued`);
    assert.equal(response.status, 302);
    assert.ok(response.location.includes('login_error=invalid_ticket'));
  });
});

test('SSO：非白名单 return_to 被忽略，回退为本站默认回调', async () => {
  await withEnvironment(async ({ base }) => {
    const evil = 'https://evil.example.com/steal';
    const startResponse = await request(`${base}/api/auth/chaoxing/start?return_to=${encodeURIComponent(evil)}`);
    assert.equal(startResponse.status, 302);
    const returnTo = new URL(startResponse.location).searchParams.get('return_to');
    assert.ok(returnTo.startsWith(base), '非法 return_to 必须回退为本站默认回调');
    assert.ok(!returnTo.includes('evil.example.com'));
  });
});

test('登出：清除会话 Cookie 并联动认证中心登出地址', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const logout = await getJson(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.ok(logout.body.logoutUrl.includes(`127.0.0.1:${center.port}`), '登出应返回认证中心登出地址');
    assert.ok(logout.body.logoutUrl.includes('/api/auth/logout'), '登出路径须与认证中心实测契约一致');
    assert.ok(
      logout.setCookies.some((item) => item.startsWith('agent_site_session=') && item.includes('Max-Age=0')),
      '登出必须下发清除 Cookie'
    );
  });
});

test('会话：伪造 Cookie 无效；登出后原 Cookie 失效', async () => {
  await withEnvironment(async ({ base, center }) => {
    const forged = await getJson(`${base}/api/auth/me`, { headers: { cookie: 'agent_site_session=forged-token' } });
    assert.equal(forged.body.user, null, '伪造 token 不得通过校验');

    const { cookie } = await login({ base, center }, 'admin');
    await request(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    const after = await getJson(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(after.body.user, null, '登出后会话必须失效');
  });
});

test('权限：未登录写入 401，管理员写入 201 并可检索到', async () => {
  await withEnvironment(async ({ base, center }) => {
    const anonymous = await getJson(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' })
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error, 'authentication_required');

    const { cookie } = await login({ base, center }, 'admin');
    const created = await getJson(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: '课程知识问答智能体',
        summary: '依据课程资料回答学生提问',
        tags: '问答,课程',
        courseName: '数据库原理',
        data: { 场景: '课程答疑', 负责人: '教学资源中心' }
      })
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.item.id.startsWith('agent_'));
    assert.deepEqual(created.body.item.data, { 场景: '课程答疑', 负责人: '教学资源中心' });

    const list = await getJson(`${base}/api/agents`);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].name, '课程知识问答智能体');
    assert.equal(list.body.items[0].data, undefined, '列表接口不应下发扩展字段');

    // 当前检索契约覆盖业务字段，扩展 JSON 仅由详情返回。
    const search = await getJson(`${base}/api/agents?q=${encodeURIComponent('数据库原理')}`);
    assert.equal(search.body.total, 1, '课程名称应参与检索');
    assert.equal(search.body.items[0].courseName, '数据库原理');

    const miss = await getJson(`${base}/api/agents?q=${encodeURIComponent('不存在')}`);
    assert.equal(miss.body.total, 0);

    const detail = await getJson(`${base}/api/agents/${created.body.item.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.item.data, { 场景: '课程答疑', 负责人: '教学资源中心' });

    const missing = await getJson(`${base}/api/agents/not_exist`);
    assert.equal(missing.status, 404);
  });
});

test('校验：缺名称 400 / 名称超长 400 / 非法 JSON 400 / 非对象 JSON 400', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const post = (body) =>
      getJson(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      });

    assert.equal((await post({ summary: '无名称' })).status, 400);
    assert.equal((await post({ name: 'x'.repeat(121) })).status, 400);
    assert.equal((await post('{坏 json')).status, 400);
    assert.equal((await post({ name: 'ok', data: '[1,2]' })).status, 400, '数组不是合法扩展对象');

    const ok = await post({ name: '合法名称' });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.item.data, {}, '未提供扩展字段时默认空对象');
  });
});

test('检索：LIKE 特殊字符按字面量处理', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const post = (body) =>
      getJson(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body)
      });
    await post({ name: '100%命中率智能体', tags: '评测' });
    await post({ name: '另一个智能体', tags: '评测' });

    const percent = await getJson(`${base}/api/agents?q=${encodeURIComponent('%')}`);
    assert.equal(percent.body.total, 1, '% 必须按字面量匹配');
    const underscore = await getJson(`${base}/api/agents?q=${encodeURIComponent('_')}`);
    assert.equal(underscore.body.total, 0, '_ 不得作为单字符通配符');
  });
});

test('方法限制：写路径拒绝 GET，详情路径拒绝 POST', async () => {
  await withEnvironment(async ({ base }) => {
    const logoutGet = await getJson(`${base}/api/auth/logout`);
    assert.equal(logoutGet.status, 405);
    const detailPost = await getJson(`${base}/api/agents/anything`, { method: 'POST' });
    assert.equal(detailPost.status, 405);
  });
});

/* ============================================================================
 * 封面上传（multipart/form-data）与字段完整性
 * ========================================================================== */

/** 1×1 透明 PNG（真实图片字节，用于验证「内容真的是图片」校验） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 构造 multipart/form-data 请求体（模拟浏览器 FormData 序列化结果） */
function multipartBody({
  boundary,
  field = 'file',
  filename = 'cover.png',
  contentType = 'image/png',
  data = PNG_1X1
}) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

const UPLOAD_BOUNDARY = '----agent-site-test-boundary';

function upload(base, cookie, body, contentType = `multipart/form-data; boundary=${UPLOAD_BOUNDARY}`) {
  return getJson(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...(cookie ? { cookie } : {}) },
    body
  });
}

test('上传：管理员上传 PNG → 201 返回站内 URL，且可按 URL 原样取回', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const uploaded = await upload(base, cookie, multipartBody({ boundary: UPLOAD_BOUNDARY }));

    assert.equal(uploaded.status, 201, uploaded.text);
    assert.match(uploaded.body.url, /^\/uploads\/\d+_[0-9a-f]{8}\.png$/, '应返回站内 /uploads/ 路径');

    // 回显链路：前台 <img src> 用的就是这个地址，必须能取到原图
    const fetched = await request(`${base}${uploaded.body.url}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers['content-type'], 'image/png');
    assert.equal(fetched.headers['content-length'], String(PNG_1X1.length));
    assert.deepEqual(fetched.bytes, PNG_1X1, '取回字节必须与上传内容完全一致');
  });
});

test('上传：GIF 内含近似边界时回读字节完整且 MIME 正确', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const comment = Buffer.from(`裸--${UPLOAD_BOUNDARY}内容\r\n--${UPLOAD_BOUNDARY}inside\r\n--${UPLOAD_BOUNDARY}--inside`);
    const image = Buffer.concat([
      gif.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b])
    ]);
    const uploaded = await upload(base, cookie, multipartBody({
      boundary: UPLOAD_BOUNDARY, filename: 'comment.gif', contentType: 'image/gif', data: image
    }));
    assert.equal(uploaded.status, 201, uploaded.text);
    const fetched = await request(`${base}${uploaded.body.url}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.bytes, image, '图片中的近似边界不得截断落盘文件');
    assert.equal(fetched.headers['content-type'], 'image/gif');
  });
});

test('上传：WebP 回显返回正确 MIME 与原始字节', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const image = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    const uploaded = await upload(base, cookie, multipartBody({
      boundary: UPLOAD_BOUNDARY, filename: 'cover.webp', contentType: 'image/webp', data: image
    }));
    assert.equal(uploaded.status, 201, uploaded.text);
    const fetched = await request(`${base}${uploaded.body.url}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers['content-type'], 'image/webp');
    assert.deepEqual(fetched.bytes, image);
  });
});

test('上传：权限与内容校验（401 匿名 / 403 非管理员 / 415 类型 / 400 假图片 / 400 无文件）', async () => {
  await withEnvironment(async ({ base, center }) => {
    assert.equal((await upload(base, null, multipartBody({ boundary: UPLOAD_BOUNDARY }))).status, 401, '匿名上传必须 401');

    const student = await login({ base, center }, 'student');
    assert.equal((await upload(base, student.cookie, multipartBody({ boundary: UPLOAD_BOUNDARY }))).status, 403, '非管理员必须 403');

    const admin = await login({ base, center }, 'admin');

    const notMultipart = await upload(base, admin.cookie, 'plain', 'application/json');
    assert.equal(notMultipart.status, 400);
    assert.equal(notMultipart.body.error, 'multipart_required');

    const bmp = multipartBody({ boundary: UPLOAD_BOUNDARY, filename: 'a.bmp', contentType: 'image/bmp' });
    const bmpResult = await upload(base, admin.cookie, bmp);
    assert.equal(bmpResult.status, 415);
    assert.equal(bmpResult.body.error, 'unsupported_image_type');

    // 扩展名/MIME 声明成 PNG，内容却是 HTML：必须按内容拒绝
    const fake = multipartBody({
      boundary: UPLOAD_BOUNDARY,
      data: Buffer.from('<html><script>alert(1)</script></html>')
    });
    const fakeResult = await upload(base, admin.cookie, fake);
    assert.equal(fakeResult.status, 400);
    assert.equal(fakeResult.body.error, 'invalid_image_data');

    const noFile = Buffer.from(
      `--${UPLOAD_BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${UPLOAD_BOUNDARY}--\r\n`
    );
    const noFileResult = await upload(base, admin.cookie, noFile);
    assert.equal(noFileResult.status, 400);
    assert.equal(noFileResult.body.error, 'file_required');
  });
});

for (const size of [4 * 1024 * 1024, 10 * 1024 * 1024]) {
  test(`上传：${size / 1024 / 1024} MB 图片可上传并完整回读`, async () => {
    await withEnvironment(async ({ base, center }) => {
      const { cookie } = await login({ base, center }, 'admin');
      const image = Buffer.alloc(size);
      PNG_1X1.copy(image);
      const result = await upload(base, cookie, multipartBody({ boundary: UPLOAD_BOUNDARY, data: image }));
      assert.equal(result.status, 201, result.text);
      const fetched = await request(`${base}${result.body.url}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.bytes, image);
    });
  });
}

for (const extra of [1, 64 * 1024]) {
  test(`上传：超过 10 MB ${extra} 字节返回可读的 413`, async () => {
    await withEnvironment(async ({ base, center }) => {
      const { cookie } = await login({ base, center }, 'admin');
      const oversized = multipartBody({ boundary: UPLOAD_BOUNDARY, data: Buffer.alloc(10 * 1024 * 1024 + extra, 1) });
      const result = await upload(base, cookie, oversized);
      assert.equal(result.status, 413, '超限必须返回 413，而不是连接被中断');
      assert.equal(result.body.error, 'file_too_large', '前端依赖该错误码给出「图片超过 10 MB」提示');
    });
  });
}

test('请求体超限：JSON 超过 64 KB 返回 413 且响应体可读（回归）', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const huge = JSON.stringify({ name: '超大请求', summary: 'y'.repeat(100 * 1024) });
    const result = await getJson(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: huge
    });
    assert.equal(result.status, 413);
    assert.equal(result.body.error, 'payload_too_large');
  });
});

test('字段完整性：新增后列表 / 详情返回全部已填写字段（前台展示不丢字段）', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const payload = {
      name: '全字段智能体',
      summary: '一句话简介',
      tags: '标签A,标签B',
      discipline: '工学',
      major: '计算机科学与技术',
      courseName: '数据结构与算法',
      schoolName: '示例大学',
      agentUrl: 'https://example.com/agent/1',
      coverImage: '/uploads/cover.png',
      painPoint: '痛点描述',
      usageGuide: '使用说明',
      status: 'active',
      data: { 场景: '课程答疑' }
    };

    const created = await getJson(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(payload)
    });
    assert.equal(created.status, 201, created.text);

    // 列表接口：卡片渲染用到的字段必须齐全（含链接，否则前台无法展示可点击链接）
    const list = await getJson(`${base}/api/agents`);
    const item = list.body.items[0];
    for (const key of [
      'name',
      'summary',
      'tags',
      'discipline',
      'major',
      'courseName',
      'schoolName',
      'agentUrl',
      'coverImage'
    ]) {
      assert.equal(item[key], payload[key], `列表字段 ${key} 必须返回已填写内容`);
    }

    // 详情接口：长文本与扩展字段
    const detail = await getJson(`${base}/api/agents/${created.body.item.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.item.painPoint, payload.painPoint);
    assert.equal(detail.body.item.usageGuide, payload.usageGuide);
    assert.equal(detail.body.item.agentUrl, payload.agentUrl);
    assert.deepEqual(detail.body.item.data, payload.data, '扩展字段必须原样返回');

    // 检索覆盖业务字段
    const searched = await getJson(`${base}/api/agents?q=${encodeURIComponent('数据结构')}`);
    assert.equal(searched.body.total, 1, '课程名称应参与关键词检索');
  });
});

test('链接字段：http(s) 与站内路径放行，javascript: / 协议相对地址拒绝', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const post = (agentUrl) =>
      getJson(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: '链接校验', agentUrl })
      });

    assert.equal((await post('https://example.com/a')).status, 201);
    assert.equal((await post('/agents.html?x=1')).status, 201, '站内相对路径放行');

    const script = await post('javascript:alert(1)');
    assert.equal(script.status, 400);
    assert.equal(script.body.error, 'invalid_agent_url');

    const protocolRelative = await post('//evil.example.com/x');
    assert.equal(protocolRelative.status, 400, '协议相对地址必须拒绝');
  });
});

test('链接字段：不可解析地址与控制字符 / 反斜杠在新增和更新时均拒绝', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const headers = { 'content-type': 'application/json', cookie };
    const created = await getJson(`${base}/api/agents`, {
      method: 'POST', headers, body: JSON.stringify({ name: '链接校验', agentUrl: '/agents.html?q=1#detail' })
    });
    assert.equal(created.status, 201);
    for (const agentUrl of ['https://', 'https://#', 'http:// bad', '/\\evil.example', '/\t/evil.example', 'https://exa\nmple.com', '/agents.html\n']) {
      for (const method of ['POST', 'PUT']) {
        const result = await getJson(method === 'POST' ? `${base}/api/agents` : `${base}/api/agents/${created.body.item.id}`, {
          method, headers, body: JSON.stringify({ name: '链接校验', agentUrl })
        });
        assert.equal(result.status, 400, `${method} 必须拒绝 ${JSON.stringify(agentUrl)}`);
        assert.equal(result.body.error, 'invalid_agent_url');
      }
    }
    const detail = await getJson(`${base}/api/agents/${created.body.item.id}`);
    assert.equal(detail.body.item.agentUrl, '/agents.html?q=1#detail', '被拒绝的修改不得覆盖原链接');
  });
});

test('更新：替换封面回收旧文件，且未提交字段保持原值', async () => {
  await withEnvironment(async ({ base, center, site }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const headers = { 'content-type': 'application/json', cookie };

    const first = await upload(base, cookie, multipartBody({ boundary: UPLOAD_BOUNDARY }));
    assert.equal(first.status, 201);
    const oldCover = first.body.url;
    const oldFile = join(site.config.uploadsDir, oldCover.replace('/uploads/', ''));
    assert.ok(existsSync(oldFile), '上传后文件应落盘');

    const created = await getJson(`${base}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '封面回收用例', coverImage: oldCover, painPoint: '原痛点' })
    });
    assert.equal(created.status, 201);

    const second = await upload(
      base,
      cookie,
      multipartBody({ boundary: UPLOAD_BOUNDARY, filename: 'next.png' })
    );
    assert.equal(second.status, 201);

    const updated = await getJson(`${base}/api/agents/${created.body.item.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ coverImage: second.body.url })
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.item.coverImage, second.body.url, '封面应更新为新文件');
    assert.equal(updated.body.item.painPoint, '原痛点', '未提交字段必须保留原值');
    assert.equal(existsSync(oldFile), false, '被替换且不再引用的旧封面应被回收');
  });
});

/* ============================================================================
 * 案例详情浏览统计（全部使用临时数据库）
 * ========================================================================== */

async function createViewCase({ base, center }) {
  const { cookie } = await login({ base, center }, 'admin');
  const created = await getJson(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '浏览统计用例', summary: '仅打开详情后显式记录浏览' })
  });
  assert.equal(created.status, 201, created.text);
  return { agent: created.body.item, adminCookie: cookie };
}

function recordView(base, id, { cookie, headers = {}, body = '{}' } = {}) {
  return getJson(`${base}/api/agents/${id}/views`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body
  });
}

function visitorCookie(response) {
  const raw = response.setCookies.find((item) => item.startsWith('agent_site_visitor='));
  assert.ok(raw, '首次匿名浏览必须种服务端访客 Cookie');
  return raw.split(';')[0];
}

function assertViewItemPrivacy(item) {
  assert.deepEqual(Object.keys(item).sort(), [
    'displayName', 'firstViewedAt', 'lastViewedAt', 'viewCount', 'visitorType'
  ], '浏览明细只返回展示字段，不泄漏访客键、Cookie、用户 ID 或 SSO 标识');
  assert.ok(Number.isFinite(item.firstViewedAt));
  assert.ok(Number.isFinite(item.lastViewedAt));
  assert.ok(item.lastViewedAt >= item.firstViewedAt);
}

test('浏览统计：匿名 Cookie 去重、不同访客分开；列表 / 详情读取不计数', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { agent, adminCookie } = await createViewCase({ base, center });
    const viewsUrl = `${base}/api/agents/${agent.id}/views`;
    const adminHeaders = { cookie: adminCookie };
    await getJson(`${base}/api/agents`);
    await getJson(`${base}/api/agents/${agent.id}`);
    const empty = await getJson(viewsUrl, { headers: adminHeaders });
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.body.viewStats, { userCount: 0, anonymousCount: 0, viewCount: 0 });
    assert.deepEqual(empty.body.items, []);

    const first = await recordView(base, agent.id, {
      body: JSON.stringify({ visitorId: 'spoofed-browser', userId: 1, ssoUid: 'u-admin' })
    });
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body, { ok: true, recorded: true });
    const cookie = visitorCookie(first);
    const cookieHeader = first.setCookies.find((item) => item.startsWith('agent_site_visitor='));
    assert.ok(cookieHeader.includes('HttpOnly'));
    assert.ok(cookieHeader.includes('SameSite=Lax'));
    assert.ok(cookieHeader.includes('Path=/'));
    assert.equal((await recordView(base, agent.id, { cookie })).status, 200);

    const another = await recordView(base, agent.id, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(another.status, 200, another.text);
    assert.notEqual(visitorCookie(another), cookie, '不同浏览器标识不得合并为同一访客');
    assert.ok(another.setCookies.some((item) => item.startsWith('agent_site_visitor=') && item.includes('Secure')), 'HTTPS 访客 Cookie 必须带 Secure');
    const detail = await getJson(viewsUrl, { headers: adminHeaders });
    assert.deepEqual(detail.body.viewStats, { userCount: 0, anonymousCount: 2, viewCount: 3 });
    assert.equal(detail.body.total, 2);
    assert.equal(detail.body.limit, 50);
    assert.equal(detail.body.offset, 0);
    assert.deepEqual(detail.body.items.map((item) => item.viewCount).sort(), [1, 2]);
    for (const item of detail.body.items) {
      assert.equal(item.visitorType, 'anonymous');
      assert.ok(item.displayName.includes('匿名'));
      assertViewItemPrivacy(item);
    }
    assert.ok(!detail.text.includes(cookie.split('=')[1]), '明细不得泄漏原始访客 Cookie');
    assert.ok(!detail.text.includes('spoofed-browser'), '前端传来的访客标识不得用于记账或返回');
    const after = await getJson(`${base}/api/agents/${agent.id}`);
    assert.equal(after.body.item.updatedAt, agent.updatedAt, '记录浏览不得修改案例更新时间');
  });
});

test('浏览统计：登录用户跨会话去重、管理员排除；公开列表只返回浏览总次数', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { agent, adminCookie } = await createViewCase({ base, center });
    const firstSession = await login({ base, center }, 'student');
    const secondSession = await login({ base, center }, 'student');
    assert.notEqual(firstSession.cookie, secondSession.cookie);
    for (const cookie of [firstSession.cookie, secondSession.cookie]) {
      const result = await recordView(base, agent.id, {
        cookie,
        body: JSON.stringify({ userId: 1, visitorId: 'fake-admin', ssoUid: 'u-admin' })
      });
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.body, { ok: true, recorded: true });
    }

    const adminView = await recordView(base, agent.id, { cookie: adminCookie });
    assert.equal(adminView.status, 200, adminView.text);
    assert.deepEqual(adminView.body, { ok: true, recorded: false });
    const adminHeaders = { cookie: adminCookie };
    const adminList = await getJson(`${base}/api/agents`, { headers: adminHeaders });
    assert.deepEqual(adminList.body.items[0].viewStats, { userCount: 1, anonymousCount: 0, viewCount: 2 });
    for (const headers of [{}, { cookie: firstSession.cookie }]) {
      const list = await getJson(`${base}/api/agents`, { headers });
      assert.deepEqual(list.body.items[0].viewStats, { viewCount: 2 }, '公开 / 普通用户列表只返回浏览总次数');
      const detail = await getJson(`${base}/api/agents/${agent.id}`, { headers });
      assert.equal(detail.body.item.viewStats, undefined);
      assert.ok(!list.text.includes('学生乙') && !detail.text.includes('学生乙'), '公开接口不返回浏览者身份');
    }

    const details = await getJson(`${base}/api/agents/${agent.id}/views`, { headers: adminHeaders });
    assert.deepEqual(details.body.viewStats, { userCount: 1, anonymousCount: 0, viewCount: 2 });
    assert.equal(details.body.total, 1);
    assert.equal(details.body.items[0].visitorType, 'user');
    assert.equal(details.body.items[0].displayName, '学生乙');
    assert.equal(details.body.items[0].viewCount, 2);
    assertViewItemPrivacy(details.body.items[0]);
    assert.ok(!details.text.includes('u-student') && !details.text.includes('fake-admin'));
  });
});

test('热门数据：公开列表返回真实零值与聚合次数，筛选 / 分页保留次数且浏览不改变排序', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const cases = [];
    for (const [index, name] of ['排行案例甲', '排行案例乙', '排行案例丙', '排行案例丁'].entries()) {
      const created = await getJson(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name, discipline: index < 2 ? '工学' : '理学' })
      });
      assert.equal(created.status, 201, created.text);
      cases.push(created.body.item);
    }
    const before = await getJson(`${base}/api/agents`);
    assert.equal(before.body.total, 4);
    for (const item of before.body.items) assert.deepEqual(item.viewStats, { viewCount: 0 });

    const counts = [0, 2, 4, 1];
    let anonymousCookie;
    for (let index = 0; index < cases.length; index += 1) {
      for (let count = 0; count < counts[index]; count += 1) {
        const viewed = await recordView(base, cases[index].id, { cookie: anonymousCookie });
        assert.equal(viewed.status, 200, viewed.text);
        if (!anonymousCookie) anonymousCookie = visitorCookie(viewed);
      }
    }
    const expectedCounts = new Map(cases.map((item, index) => [item.id, counts[index]]));
    const after = await getJson(`${base}/api/agents`);
    assert.deepEqual(after.body.items.map((item) => [item.id, item.updatedAt]),
      before.body.items.map((item) => [item.id, item.updatedAt]), '热门聚合不能改变列表排序或案例更新时间');
    for (const item of after.body.items) {
      assert.deepEqual(item.viewStats, { viewCount: expectedCounts.get(item.id) });
    }

    const filtered = await getJson(`${base}/api/agents?discipline=${encodeURIComponent('理学')}`);
    assert.equal(filtered.body.total, 2);
    for (const item of filtered.body.items) {
      assert.deepEqual(item.viewStats, { viewCount: expectedCounts.get(item.id) });
    }
    const searched = await getJson(`${base}/api/agents?q=${encodeURIComponent('排行案例丙')}`);
    assert.equal(searched.body.total, 1);
    assert.deepEqual(searched.body.items[0].viewStats, { viewCount: 4 });
    const pages = [];
    for (const offset of [0, 2]) {
      const page = await getJson(`${base}/api/agents?limit=2&offset=${offset}`);
      assert.equal(page.body.total, 4);
      pages.push(...page.body.items);
    }
    assert.deepEqual(pages, after.body.items, '前台可按现有分页接口取得全局浏览次数');
  });
});

test('浏览统计：明细匿名 401 / 普通用户 403，跨站记录 403 且不写入', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { agent, adminCookie } = await createViewCase({ base, center });
    const viewsUrl = `${base}/api/agents/${agent.id}/views`;
    assert.equal((await getJson(viewsUrl)).status, 401);
    const student = await login({ base, center }, 'student');
    assert.equal((await getJson(viewsUrl, { headers: { cookie: student.cookie } })).status, 403);
    for (const headers of [
      { origin: 'https://other.example' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: base, 'sec-fetch-site': 'cross-site' }
    ]) {
      const rejected = await recordView(base, agent.id, { cookie: student.cookie, headers });
      assert.equal(rejected.status, 403, `跨站记录应拒绝 ${JSON.stringify(headers)}: ${rejected.text}`);
    }
    const empty = await getJson(viewsUrl, { headers: { cookie: adminCookie } });
    assert.deepEqual(empty.body.viewStats, { userCount: 0, anonymousCount: 0, viewCount: 0 });
    const accepted = await recordView(base, agent.id, { cookie: student.cookie, headers: { origin: base, 'sec-fetch-site': 'same-origin' } });
    assert.equal(accepted.status, 200, accepted.text);
  });
});

test('浏览统计：明细分页 / 边界归一化，不因读取统计而重复计数', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { agent, adminCookie } = await createViewCase({ base, center });
    for (let index = 0; index < 3; index++) {
      assert.equal((await recordView(base, agent.id)).status, 200);
    }
    const viewsUrl = `${base}/api/agents/${agent.id}/views`;
    const headers = { cookie: adminCookie };
    const page = await getJson(`${viewsUrl}?limit=1&offset=1`, { headers });
    assert.equal(page.status, 200, page.text);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.total, 3);
    assert.equal(page.body.limit, 1);
    assert.equal(page.body.offset, 1);
    assert.deepEqual(page.body.viewStats, { userCount: 0, anonymousCount: 3, viewCount: 3 });
    const clamped = await getJson(`${viewsUrl}?limit=1000&offset=-10`, { headers });
    assert.equal(clamped.body.limit, 100);
    assert.equal(clamped.body.offset, 0);
    assert.equal(clamped.body.items.length, 3);
    const invalid = await getJson(`${viewsUrl}?limit=wrong&offset=wrong`, { headers });
    assert.equal(invalid.body.limit, 50);
    assert.equal(invalid.body.offset, 0);
    const beyond = await getJson(`${viewsUrl}?limit=1&offset=99`, { headers });
    assert.deepEqual(beyond.body.items, []);
    assert.equal(beyond.body.total, 3);
    assert.deepEqual(beyond.body.viewStats, { userCount: 0, anonymousCount: 3, viewCount: 3 });
  });
});

test('浏览统计：不存在案例 404 / 损坏路径 400 / 不支持方法 405', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { agent, adminCookie } = await createViewCase({ base, center });
    assert.equal((await recordView(base, 'not_exist')).status, 404);
    assert.equal((await getJson(`${base}/api/agents/not_exist/views`, { headers: { cookie: adminCookie } })).status, 404);
    assert.equal((await recordView(base, '%E0%A4%A')).status, 400, '损坏的 URI 编码必须返回 400');
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await getJson(`${base}/api/agents/${agent.id}/views`, { method, headers: { cookie: adminCookie } });
      assert.equal(response.status, 405, `${method} 不得写浏览统计`);
    }
  });
});

test('浏览统计：删除案例级联回收其浏览记录，不影响其他案例', async () => {
  await withEnvironment(async ({ base, center, site }) => {
    const first = await createViewCase({ base, center });
    const second = await createViewCase({ base, center });
    const viewed = await recordView(base, first.agent.id);
    assert.equal(viewed.status, 200, viewed.text);
    assert.equal((await recordView(base, second.agent.id, { cookie: visitorCookie(viewed) })).status, 200);
    const deleted = await getJson(`${base}/api/agents/${first.agent.id}`, {
      method: 'DELETE', headers: { cookie: first.adminCookie }
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(site.db.listAgentViews(first.agent.id, { limit: 50, offset: 0 }).total, 0, '案例删除后不应遗留浏览记录');
    const remaining = await getJson(`${base}/api/agents/${second.agent.id}/views`, { headers: { cookie: second.adminCookie } });
    assert.deepEqual(remaining.body.viewStats, { userCount: 0, anonymousCount: 1, viewCount: 1 });
  });
});

/* ---------------- 全站卡片效果配置 ---------------- */

test('卡片效果：未保存时公开默认配置，支持读取且其他方法返回 405 / Allow', async () => {
  await withEnvironment(async ({ base, center }) => {
    const student = await login({ base, center }, 'student');
    for (const headers of [{}, { cookie: student.cookie }]) {
      const result = await getJson(`${base}/api/card-effects`, { headers });
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.body, { settings: DEFAULT_CARD_EFFECT_SETTINGS, updatedAt: null });
    }
    for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = await getJson(`${base}/api/card-effects`, { method });
      assert.equal(result.status, 405, result.text);
      assert.equal(result.headers.allow, 'GET, PUT');
    }
  });
});

test('卡片效果：仅管理员保存，公开读取新配置；大小写归一、更新覆盖且不改变案例', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { agent, adminCookie } = await createViewCase({ base, center });
    const before = await getJson(`${base}/api/agents/${agent.id}`);
    const settings = { ...DEFAULT_CARD_EFFECT_SETTINGS, flame1: '#AABBCC', flame2: '#BBCCDD', flame3: '#CCDDEE', brightness: 1.4 };
    const save = await getJson(`${base}/api/card-effects`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: base, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ settings })
    });
    assert.equal(save.status, 200, save.text);
    assert.deepEqual(save.body.settings, { ...settings, flame1: '#aabbcc', flame2: '#bbccdd', flame3: '#ccddee' });
    assert.ok(Number.isInteger(save.body.updatedAt));
    assert.ok(save.body.updatedAt > 0);
    const publicRead = await getJson(`${base}/api/card-effects`);
    assert.deepEqual(publicRead.body, save.body);

    const next = { ...save.body.settings, speed: 1.25, opacity: 0.75, flame3: '#00DD55' };
    const updated = await getJson(`${base}/api/card-effects`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ settings: next })
    });
    assert.equal(updated.status, 200, updated.text);
    assert.deepEqual(updated.body.settings, { ...next, flame3: '#00dd55' });
    assert.ok(updated.body.updatedAt >= save.body.updatedAt);
    assert.deepEqual((await getJson(`${base}/api/card-effects`)).body, updated.body);
    assert.deepEqual((await getJson(`${base}/api/agents/${agent.id}`)).body, before.body, '效果配置不能改动案例字段或更新时间');
  });
});

test('卡片效果：匿名 401 / 普通用户 403，跨来源管理员保存 403 且不写入', async () => {
  await withEnvironment(async ({ base, center }) => {
    const admin = await login({ base, center }, 'admin');
    const student = await login({ base, center }, 'student');
    const url = `${base}/api/card-effects`;
    const body = JSON.stringify({ settings: DEFAULT_CARD_EFFECT_SETTINGS });
    const put = (headers) => getJson(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await put({})).status, 401);
    assert.equal((await put({ cookie: student.cookie })).status, 403);
    for (const source of [{ origin: 'https://other.example' }, { origin: 'null' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
      const result = await put({ cookie: admin.cookie, ...source });
      assert.equal(result.status, 403, result.text);
      assert.equal(result.body.error, 'cross_origin_forbidden');
    }
    assert.deepEqual((await getJson(url)).body, { settings: DEFAULT_CARD_EFFECT_SETTINGS, updatedAt: null });
  });
});

test('卡片效果：完整参数严格校验，非法值不得静默限幅或写入，沿用 64 KB 请求限制', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const url = `${base}/api/card-effects`;
    const put = (body) => getJson(url, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body });
    const invalidBodies = [null, [], 'text', {}, { settings: null }, { settings: [] }, { settings: {} },
      { settings: { ...DEFAULT_CARD_EFFECT_SETTINGS, unknown: 1 } },
      { settings: DEFAULT_CARD_EFFECT_SETTINGS, unknown: 1 },
      { settings: { ...DEFAULT_CARD_EFFECT_SETTINGS, speed: '0.5' } },
      { settings: { ...DEFAULT_CARD_EFFECT_SETTINGS, opacity: null } }];
    const missing = { ...DEFAULT_CARD_EFFECT_SETTINGS };
    delete missing.flame1;
    invalidBodies.push({ settings: missing }, { settings: { ...missing, unknown: '#112233' } });
    for (const field of CARD_EFFECT_FIELDS) {
      if (field.type === 'color') {
        invalidBodies.push({ settings: { ...DEFAULT_CARD_EFFECT_SETTINGS, [field.key]: '#abc' } });
      } else {
        for (const value of [field.min - 0.1, field.max + 0.1]) {
          invalidBodies.push({ settings: { ...DEFAULT_CARD_EFFECT_SETTINGS, [field.key]: value } });
        }
      }
    }
    for (const payload of invalidBodies) {
      const result = await put(JSON.stringify(payload));
      assert.equal(result.status, 400, JSON.stringify(payload));
    }
    const infinite = JSON.stringify({ settings: DEFAULT_CARD_EFFECT_SETTINGS }).replace('"speed":0.5', '"speed":1e999');
    assert.equal((await put(infinite)).status, 400, 'JSON 中超出有限数字范围必须拒绝');
    assert.equal((await put('{')).status, 400);
    const oversized = await put(JSON.stringify({ settings: DEFAULT_CARD_EFFECT_SETTINGS, padding: 'x'.repeat(70 * 1024) }));
    assert.equal(oversized.status, 413, oversized.text);
    assert.equal(oversized.body.error, 'payload_too_large');
    assert.deepEqual((await getJson(url)).body, { settings: DEFAULT_CARD_EFFECT_SETTINGS, updatedAt: null }, '失败请求不得发布任何参数');

    for (const bound of ['min', 'max']) {
      const settings = { ...DEFAULT_CARD_EFFECT_SETTINGS };
      for (const field of CARD_EFFECT_FIELDS) {
        if (field.type === 'number') settings[field.key] = field[bound];
      }
      const saved = await put(JSON.stringify({ settings }));
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(saved.body.settings, settings, '合法范围边界应原样保存');
    }
  });
});

test('卡片效果消散速度：非零参数保存回读，越界 / 类型错误 / 缺项拒绝且不覆盖已保存配置', async () => {
  await withEnvironment(async ({ base, center }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const url = `${base}/api/card-effects`;
    const put = (settings) => getJson(url, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ settings })
    });
    const settings = { ...DEFAULT_CARD_EFFECT_SETTINGS, decaySpeed: 1.35 };
    const saved = await put(settings);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.settings, settings);
    assert.deepEqual((await getJson(url)).body, saved.body);
    for (const decaySpeed of [-0.05, 3.05, '1.35', null]) {
      const invalid = await put({ ...settings, decaySpeed });
      assert.equal(invalid.status, 400, JSON.stringify(decaySpeed));
      assert.equal(invalid.body.error, 'invalid_card_effect_settings');
    }
    const missing = { ...settings };
    delete missing.decaySpeed;
    assert.equal((await put(missing)).status, 400, '写入仍要求包含新增消散速度的完整配置');
    assert.deepEqual((await getJson(url)).body, saved.body, '失败写入不能更改已发布参数或更新时间');
  });
});

test('卡片效果消散速度：旧 15 字段配置公开补默认零值，不回写原始 JSON 或更新时间', async () => {
  await withEnvironment(async ({ base, site }) => {
    const legacy = { ...DEFAULT_CARD_EFFECT_SETTINGS, brightness: 1.25, flame3: '#123456' };
    delete legacy.decaySpeed;
    assert.equal(Object.keys(legacy).length, 15);
    site.db.saveCardEffectSettings(legacy, 123456);
    const stored = site.db.cardEffectSettings();
    assert.equal(Object.hasOwn(stored.settings, 'decaySpeed'), false);
    const result = await getJson(`${base}/api/card-effects`);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body, { settings: { ...legacy, decaySpeed: 0 }, updatedAt: 123456 });
    assert.deepEqual(site.db.cardEffectSettings(), stored, '读取只归一化响应，不迁移或重写旧配置');
  });
});

/* ---------------- 智能体对话入口（测试 provider 不访问外网） ---------------- */

function chatRequest(base, messages, headers = {}) {
  return getJson(`${base}/api/agents/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages })
  });
}

function seedChatCase(db, id, updatedAt = 100, overrides = {}) {
  return db.insertAgent({
    id, name: `对话案例${id}`, summary: '真实库中的案例简介', tags: '示例', status: 'active', dataJson: '{}',
    discipline: '工学', major: '计算机', courseName: '数据结构', agentUrl: `/agents/${id}`,
    schoolName: '示例大学', coverImage: '', painPoint: '知识检索', usageGuide: '浏览案例',
    createdBy: null, createdAt: 100, updatedAt, ...overrides
  });
}

test('智能体对话：匿名可用；未接入 AI 明确返回 503；仅支持 POST / Allow', async () => {
  await withEnvironment(async ({ base }) => {
    const result = await chatRequest(base, [{ role: 'user', content: '找一个课程问答案例' }]);
    assert.equal(result.status, 503, result.text);
    assert.deepEqual(result.body, { error: 'ai_not_configured' });
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const rejected = await getJson(`${base}/api/agents/chat`, { method });
      assert.equal(rejected.status, 405, rejected.text);
      assert.equal(rejected.headers.allow, 'POST');
    }
  });
});

test('智能体对话：消息严格校验，非法 JSON / 超过 64 KB 不得调用 provider', async () => {
  let calls = 0;
  await withEnvironment(async ({ base }) => {
    const invalid = [undefined, null, 'text', {}, [],
      Array.from({ length: 21 }, () => ({ role: 'user', content: '问题' })),
      [null], [{ role: 'system', content: '问题' }], [{ role: 'assistant', content: '回答' }],
      [{ role: 'user', content: '' }], [{ role: 'user', content: '  \n ' }],
      [{ role: 'user', content: 5 }], [{ role: 'user', content: 'x'.repeat(2001) }]];
    for (const messages of invalid) {
      const response = await chatRequest(base, messages);
      assert.equal(response.status, 400, JSON.stringify(messages));
      assert.equal(response.body.error, 'invalid_messages');
    }
    for (const body of ['{', 'null', '[]', '"text"']) {
      const result = await getJson(`${base}/api/agents/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body
      });
      assert.equal(result.status, 400, result.text);
    }
    const oversized = await getJson(`${base}/api/agents/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '问题' }], padding: 'x'.repeat(70 * 1024) })
    });
    assert.equal(oversized.status, 413, oversized.text);
    assert.equal(oversized.body.error, 'payload_too_large');
    assert.equal(calls, 0);
  }, { agentChatProvider() { calls++; return { reply: '回复', agentIds: [] }; } });
});

test('智能体对话：来源保护与浏览写入一致，同源放行且跨来源不调用 provider', async () => {
  let calls = 0;
  await withEnvironment(async ({ base }) => {
    const messages = [{ role: 'user', content: '课程问答' }];
    for (const headers of [
      { origin: 'https://other.example' }, { origin: 'null' },
      { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
      { origin: base, 'sec-fetch-site': 'cross-site' }
    ]) {
      const result = await chatRequest(base, messages, headers);
      assert.equal(result.status, 403, result.text);
      assert.deepEqual(result.body, { error: 'cross_origin_forbidden' });
    }
    assert.equal(calls, 0);
    const accepted = await chatRequest(base, messages, { origin: base, 'sec-fetch-site': 'same-origin' });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(calls, 1);
  }, { agentChatProvider() { calls++; return { reply: '没有匹配案例', agentIds: [] }; } });
});

test('智能体对话：provider 只接收归一消息和公开案例，旧推荐取真实库字段、去重且最多五条', async () => {
  let expectedIds;
  await withEnvironment(async ({ base, site }) => {
    expectedIds = Array.from({ length: 8 }, (_, index) => `chat_${index}`);
    for (const [index, id] of expectedIds.entries()) seedChatCase(site.db, id, 100 + index);
    const before = site.db.listAgents().items.map((row) => [row.id, row.updated_at]);
    const result = await chatRequest(base, [
      { role: 'user', content: ' 找课程问答 ', userId: 'forged-user' },
      { role: 'assistant', content: ' 想了解哪门课程？ ' },
      { role: 'user', content: ' 数据结构 ' }
    ]);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.reply, '这些案例可供查看');
    assert.deepEqual(result.body.items.map((item) => item.id), [expectedIds[3], expectedIds[0], ...expectedIds.slice(1, 3), expectedIds[4]]);
    assert.equal(result.body.items[0].name, `对话案例${expectedIds[3]}`);
    assert.equal(result.body.items[0].agentUrl, `/agents/${expectedIds[3]}`, '返回库中真实链接而非 provider 篡改后的链接');
    assert.equal(result.body.items[0].summary, '真实库中的案例简介');
    for (const item of result.body.items) {
      assert.equal(Object.hasOwn(item, 'matchScore'), false, '旧 provider 未给评分时不得编造');
      assert.equal(Object.hasOwn(item, 'matchReason'), false, '旧 provider 未给理由时不得编造');
    }
    assert.ok(!result.text.includes('evil.example') && !result.text.includes('forged-user'));
    assert.deepEqual(site.db.listAgents().items.map((row) => [row.id, row.updated_at]), before, '聊天不修改案例或计入详情浏览');
    for (const id of expectedIds) assert.equal(site.db.agentViewStats(id).viewCount, 0);
  }, { agentChatProvider({ messages, agents, ...other }) {
    assert.deepEqual(other, {});
    assert.deepEqual(messages, [
      { role: 'user', content: '找课程问答' }, { role: 'assistant', content: '想了解哪门课程？' }, { role: 'user', content: '数据结构' }
    ]);
    assert.equal(agents.length, 8);
    for (const item of agents) {
      for (const key of ['created_by', 'user_id', 'sso_uid', 'visitor_key', 'viewStats']) assert.equal(Object.hasOwn(item, key), false);
    }
    agents[0].agentUrl = 'https://evil.example/mutated';
    return {
      reply: ' 这些案例可供查看 ',
      agentIds: ['invented', 'https://evil.example/case', expectedIds[3], expectedIds[3], ...expectedIds]
    };
  } });
});

test('智能体对话：评分推荐按分数降序稳定排序，去重且最多五条，只合并真实案例的两个字段', async () => {
  await withEnvironment(async ({ base, site }) => {
    for (let index = 0; index < 8; index++) seedChatCase(site.db, `score_${index}`);
    seedChatCase(site.db, 'metadata_only');
    const result = await chatRequest(base, [{ role: 'user', content: '推荐课程案例' }]);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body.items.map((item) => [item.id, item.matchScore]), [
      ['score_1', 100], ['score_2', 90], ['score_3', 90], ['score_4', 80], ['score_5', 70]
    ]);
    for (const item of result.body.items) {
      const detail = await getJson(`${base}/api/agents/${item.id}`);
      const { matchScore, matchReason, ...summary } = item;
      assert.equal(matchReason, `适合 ${item.id}`);
      assert.deepEqual(summary, Object.fromEntries(Object.keys(summary).map((key) => [key, detail.body.item[key]])), '案例字段来自真实记录');
      assert.equal(item.agentUrl, `/agents/${item.id}`, '链接仍来自真实记录');
      for (const key of ['forged', 'recommendations']) assert.equal(Object.hasOwn(item, key), false, key);
    }
    assert.ok(!result.text.includes('evil.example') && !result.text.includes('invented'));
  }, { agentChatProvider() {
    return {
      reply: '推荐如下',
      agentIds: ['invented', 'score_0', 'score_1', 'score_2', 'score_3', 'score_1', 'score_4', 'score_5', 'score_6', 'score_7'],
      recommendations: [
        { id: 'invented', matchScore: 100, matchReason: '不存在的记录' },
        { id: 'metadata_only', matchScore: 100, matchReason: '未被选中的记录' },
        ...[0, 100, 90, 90, 80, 70, 60, 50].map((matchScore, index) => ({
          id: `score_${index}`, matchScore, matchReason: `  适合 score_${index}  `,
          agentUrl: 'https://evil.example/forged', name: '伪造名称', forged: true
        }))
      ]
    };
  } });
});

test('智能体对话：评分接受 0 和 100，理由去两端空白并原样保留 JSON 特殊字符', async () => {
  const escapedReason = '包含 "引号"、\\反斜线\n换行和 <script>alert(1)</script>';
  await withEnvironment(async ({ base, site }) => {
    seedChatCase(site.db, 'score_zero');
    seedChatCase(site.db, 'score_full');
    const result = await chatRequest(base, [{ role: 'user', content: '推荐课程案例' }]);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body.items.map((item) => [item.id, item.matchScore, item.matchReason]), [
      ['score_full', 100, '理'.repeat(300)], ['score_zero', 0, escapedReason]
    ]);
  }, { agentChatProvider() {
    return {
      reply: '推荐如下', agentIds: ['score_zero', 'score_full'], recommendations: [
        { id: 'score_zero', matchScore: 0, matchReason: `  ${escapedReason}  ` },
        { id: 'score_full', matchScore: 100, matchReason: ` ${'理'.repeat(300)} ` }
      ]
    };
  } });
});

test('智能体对话：有效推荐不足三条时保留零、一、两条，不补齐案例', async () => {
  let count = 0;
  await withEnvironment(async ({ base, site }) => {
    seedChatCase(site.db, 'few_0');
    seedChatCase(site.db, 'few_1');
    for (count of [0, 1, 2]) {
      const result = await chatRequest(base, [{ role: 'user', content: '推荐课程案例' }]);
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.body.items.map((item) => item.id), Array.from({ length: count }, (_, index) => `few_${index}`));
      assert.equal(result.body.items.length, count);
    }
  }, { agentChatProvider() {
    const recommendations = Array.from({ length: count }, (_, index) => ({
      id: `few_${index}`, matchScore: 90, matchReason: '符合当前课程需求'
    }));
    return { reply: count ? '推荐如下' : '暂无匹配案例', agentIds: recommendations.map((item) => item.id), recommendations };
  } });
});

test('智能体对话：评分契约必须覆盖所选真实候选，未知或停用 ID 仍过滤', async () => {
  let recommendations = [{ id: 'scored', matchScore: 90, matchReason: '符合课程需求' }];
  await withEnvironment(async ({ base, site }) => {
    seedChatCase(site.db, 'scored');
    seedChatCase(site.db, 'missing_score');
    seedChatCase(site.db, 'inactive_score', 100, { status: 'inactive' });
    for (const incomplete of [recommendations, []]) {
      recommendations = incomplete;
      const result = await chatRequest(base, [{ role: 'user', content: '推荐课程案例' }]);
      assert.equal(result.status, 502, result.text);
      assert.deepEqual(result.body, { error: 'ai_unavailable' });
    }
    recommendations = [
      { id: 'scored', matchScore: 90, matchReason: '符合课程需求' },
      { id: 'missing_score', matchScore: 80, matchReason: '适合当前课程' }
    ];
    const complete = await chatRequest(base, [{ role: 'user', content: '推荐课程案例' }]);
    assert.equal(complete.status, 200, complete.text);
    assert.deepEqual(complete.body.items.map((item) => item.id), ['scored', 'missing_score']);
  }, { agentChatProvider() {
    return { reply: '推荐如下', agentIds: ['scored', 'missing_score', 'unknown', 'inactive_score'], recommendations };
  } });
});

test('智能体对话：非法评分推荐统一返回 502，不接受缺失、字符串或小数分数与空白、过长理由', async () => {
  let recommendations;
  await withEnvironment(async ({ base, site }) => {
    seedChatCase(site.db, 'scored');
    const valid = { id: 'scored', matchScore: 90, matchReason: '符合课程需求' };
    const invalid = [
      undefined, null, {}, '评分', [null], [[]], [7], ['评分'], [{}],
      ...[undefined, null, 7, '', '   '].map((id) => [{ ...valid, id }]),
      ...[undefined, null, -1, 101, 0.5, '90', NaN, Infinity].map((matchScore) => [{ ...valid, matchScore }]),
      ...[undefined, null, 7, '', '  \n ', '理'.repeat(301)].map((matchReason) => [{ ...valid, matchReason }])
    ];
    for (recommendations of invalid) {
      const result = await chatRequest(base, [{ role: 'user', content: '推荐课程案例' }]);
      assert.equal(result.status, 502, JSON.stringify(recommendations));
      assert.deepEqual(result.body, { error: 'ai_unavailable' });
    }
  }, { agentChatProvider() {
    return { reply: '推荐如下', agentIds: ['scored'], recommendations };
  } });
});

test('智能体对话：每轮读取完整公开详情，新增、编辑、停用、启用和删除即时生效', async () => {
  const inputs = [];
  await withEnvironment(async ({ base, center, site }) => {
    const { cookie } = await login({ base, center }, 'admin');
    const headers = { 'content-type': 'application/json', cookie };
    const ask = async () => {
      const result = await chatRequest(base, [{ role: 'user', content: '查找课程案例' }], { cookie });
      assert.equal(result.status, 200, result.text);
      return { result, input: inputs.at(-1) };
    };
    assert.deepEqual((await ask()).input.agents, []);
    const payload = {
      name: '新建课程案例', summary: '新建简介', tags: '课程答疑', status: 'active',
      discipline: '工学', major: '计算机', courseName: '数据结构', schoolName: '示例大学',
      agentUrl: 'https://example.com/course', coverImage: '/uploads/course.png',
      painPoint: '学生难以定位知识缺口', usageGuide: '输入课程问题并查看解释',
      data: { 场景: '课后复习', 建设内容: { 材料: ['讲义', '实验案例'] } }
    };
    const created = await getJson(`${base}/api/agents`, {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.item.id;
    assert.ok(site.db.findAgentById(id).created_by, '测试案例确实有登录创建者');
    const first = await ask();
    assert.deepEqual(first.input.agents, [created.body.item], '完整详情含痛点、指南、扩展字段与真实 ID');
    assert.deepEqual(Object.keys(first.input).sort(), ['agents', 'messages']);
    for (const key of ['created_by', 'createdBy', 'user_id', 'userId', 'sso_uid', 'visitor_key', 'viewStats', 'cookie']) {
      assert.equal(Object.hasOwn(first.input.agents[0], key), false, key);
    }
    assert.ok(!JSON.stringify(first.input).includes(cookie) && !JSON.stringify(first.input).includes('u-admin'));
    assert.deepEqual(first.result.body.items.map((item) => item.id), [id]);

    const inactive = await getJson(`${base}/api/agents`, {
      method: 'POST', headers, body: JSON.stringify({ name: '停用案例', status: 'inactive' })
    });
    assert.equal(inactive.status, 201, inactive.text);
    const edited = await getJson(`${base}/api/agents/${id}`, {
      method: 'PUT', headers, body: JSON.stringify({
        name: '修改后的课程案例', painPoint: '新的教学痛点', usageGuide: '新的使用步骤',
        data: { 场景: '考前复习', 建设内容: { 材料: ['更新讲义'] } }
      })
    });
    assert.equal(edited.status, 200, edited.text);
    const next = await ask();
    assert.deepEqual(next.input.agents, [edited.body.item], '下一轮只读取当前启用记录的最新详情');
    assert.equal(next.result.body.items[0].name, edited.body.item.name);

    const disabled = await getJson(`${base}/api/agents/${id}`, {
      method: 'PUT', headers, body: JSON.stringify({ status: 'inactive' })
    });
    assert.equal(disabled.status, 200, disabled.text);
    assert.deepEqual((await ask()).input.agents, []);
    const enabled = await getJson(`${base}/api/agents/${id}`, {
      method: 'PUT', headers, body: JSON.stringify({ status: 'active' })
    });
    assert.equal(enabled.status, 200, enabled.text);
    assert.deepEqual((await ask()).input.agents, [enabled.body.item]);
    const deleted = await getJson(`${base}/api/agents/${id}`, { method: 'DELETE', headers });
    assert.equal(deleted.status, 200, deleted.text);
    const final = await ask();
    assert.deepEqual(final.input.agents, []);
    assert.deepEqual(final.result.body.items, []);
  }, { agentChatProvider(input) {
    inputs.push(structuredClone(input));
    return { reply: '当前课程案例', agentIds: input.agents.map((item) => item.id) };
  } });
});

test('智能体对话：模型等待期间停用的案例不返回，仍启用案例返回最新库字段', async () => {
  let activeBase;
  let adminHeaders;
  await withEnvironment(async ({ base, center, site }) => {
    activeBase = base;
    const { cookie } = await login({ base, center }, 'admin');
    adminHeaders = { 'content-type': 'application/json', cookie };
    seedChatCase(site.db, 'chat_disabled');
    seedChatCase(site.db, 'chat_current');
    const result = await chatRequest(base, [{ role: 'user', content: '查看当前案例' }]);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body.items.map((item) => item.id), ['chat_current']);
    assert.equal(result.body.items[0].name, '等待期间更新的案例');
  }, { async agentChatProvider({ agents }) {
    assert.equal(agents.length, 2);
    const disabled = await getJson(`${activeBase}/api/agents/chat_disabled`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ status: 'inactive' })
    });
    assert.equal(disabled.status, 200, disabled.text);
    const edited = await getJson(`${activeBase}/api/agents/chat_current`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: '等待期间更新的案例' })
    });
    assert.equal(edited.status, 200, edited.text);
    return { reply: '当前推荐案例', agentIds: ['chat_disabled', 'chat_current'] };
  } });
});

test('智能体对话：候选池最多最新五百条，响应过滤已删除或不在候选池的案例', async () => {
  let activeSite;
  await withEnvironment(async ({ base, site }) => {
    activeSite = site;
    for (let index = 0; index < 501; index++) seedChatCase(site.db, `pool_${index}`, index);
    seedChatCase(site.db, 'pool_inactive', 1000, { status: 'inactive' });
    const result = await chatRequest(base, [{ role: 'user', content: '查找案例' }]);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body.items.map((item) => item.id), ['pool_499']);
  }, { agentChatProvider({ agents }) {
    assert.equal(agents.length, 500);
    assert.equal(agents[0].id, 'pool_500');
    assert.equal(agents.at(-1).id, 'pool_1');
    activeSite.db.deleteAgent('pool_500');
    return { reply: '查看推荐案例', agentIds: ['pool_500', 'pool_0', 'pool_499'] };
  } });
});

test('智能体对话：provider 异常或非法输出统一 502，不泄漏原始错误与配置', async () => {
  let output;
  let throws = false;
  await withEnvironment(async ({ base }) => {
    const messages = [{ role: 'user', content: '查找课程智能体' }];
    const invalid = [null, [], '回复', {}, { reply: '', agentIds: [] }, { reply: '  ', agentIds: [] },
      { reply: 7, agentIds: [] }, { reply: '回复', agentIds: null }, { reply: '回复', agentIds: 'id' },
      { reply: '回复', agentIds: [7] }, { reply: '回复', agentIds: [{ id: 'forged', agentUrl: 'https://evil.example' }] }];
    for (output of invalid) {
      const result = await chatRequest(base, messages);
      assert.equal(result.status, 502, JSON.stringify(output));
      assert.deepEqual(result.body, { error: 'ai_unavailable' });
    }
    throws = true;
    const failed = await chatRequest(base, messages);
    assert.equal(failed.status, 502, failed.text);
    assert.deepEqual(failed.body, { error: 'ai_unavailable' });
    assert.ok(!failed.text.includes('secret') && !failed.text.includes('upstream'));
  }, { agentChatProvider() {
    if (throws) throw new Error('upstream token secret-123');
    return output;
  } });
});
