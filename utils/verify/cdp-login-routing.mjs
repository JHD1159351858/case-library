/**
 * 登录分流与回调提示 CDP 验证脚本（开发工具，非交付产物）
 *
 * 用途：验证「登录后按角色分流 + 回调提示」相关改动在真实浏览器 + 真实后端上的表现：
 *
 *   1. 回调提示消费（匿名态即可验证）：
 *      - /agents.html?login=ok         → 提示「登录成功，欢迎回来。」
 *      - /agents.html?logout=1         → 提示「已退出登录。」
 *      - /agents.html?login_error=xx   → 提示对应中文错误（error 色调）
 *      - 提示出现后地址栏参数被清理（刷新不重复提示）
 *   2. 管理员（注入会话）在查询平台：
 *      - 顶栏出现「管理端 →」入口
 *      - 点击入口可跳转 admin.html 且门禁放行（可新增智能体）
 *   3. 普通用户（注入会话）：
 *      - 查询平台顶栏不出现「管理端 →」入口
 *      - 直达 admin.html 显示「无管理员权限」门禁，不泄漏表单
 *
 * 安全说明：脚本为验证「已登录」链路，会向数据库写入两个临时用户与两条临时会话
 * （令牌随机生成，仅验证进程与本次浏览器知晓），结束时全部清理。
 *
 * 运行：node utils/verify/cdp-login-routing.mjs [baseUrl]
 * 前置：后端已启动（node .preview-server.js）；Chrome 以 --remote-debugging-port=9222 启动
 * 产物：utils/verify/shots/login-routing/（截图 + report.json）
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:2001').replace(/\/$/, '');
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'login-routing');
const DB_PATH = join(process.cwd(), 'database', 'agent-website.db');
const SESSION_COOKIE = 'agent_site_session';

const ADMIN_UID = 'crow5_routing_admin';
const USER_UID = 'crow5_routing_user';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);
const now = () => Date.now();

/* ============================ 数据库准备 / 清理 ============================ */

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 4000;');

const ts0 = now();
const preexisting = {
  admin: db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(ADMIN_UID)?.id ?? null,
  user: db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(USER_UID)?.id ?? null
};

const sessions = [
  { uid: ADMIN_UID, token: randomBytes(32).toString('base64url') },
  { uid: USER_UID, token: randomBytes(32).toString('base64url') }
];

function ensureUser(uid, displayName, role, isAdmin) {
  const existing = db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(uid);
  if (existing) return existing.id;
  db.prepare(
    `INSERT INTO users (sso_uid, name, display_name, role, roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, '', '', 'Crow5 分流验证', ?, ?, ?, ?)`
  ).run(uid, uid, displayName, role, JSON.stringify(role ? [role] : []), isAdmin ? 1 : 0, ts0, ts0, ts0);
  return db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(uid).id;
}

function seedSessions() {
  const adminId = ensureUser(ADMIN_UID, 'Crow5 验证管理员', 'admin', 1);
  const userId = ensureUser(USER_UID, 'Crow5 验证普通用户', 'student', 0);
  for (const item of sessions) {
    const userId2 = item.uid === ADMIN_UID ? adminId : userId;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      createHash('sha256').update(item.token).digest('hex'),
      userId2,
      now() + 60 * 60 * 1000,
      now()
    );
  }
}

function cleanup() {
  const removed = { sessions: 0, users: 0 };
  try {
    for (const item of sessions) {
      removed.sessions += db
        .prepare('DELETE FROM sessions WHERE token_hash = ?')
        .run(createHash('sha256').update(item.token).digest('hex')).changes;
    }
    if (!preexisting.admin) removed.users += db.prepare('DELETE FROM users WHERE sso_uid = ?').run(ADMIN_UID).changes;
    if (!preexisting.user) removed.users += db.prepare('DELETE FROM users WHERE sso_uid = ?').run(USER_UID).changes;
  } catch (err) {
    console.error('[cleanup] 清理异常:', err.message);
  }
  db.close();
  return removed;
}

/* ================================ CDP 封装 ================================ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    this.filtered = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.exception?.description || d.text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const entry = msg.params.entry;
        const text = `[${entry.source}] ${entry.text}`;
        if (/favicon\.ico/i.test(text) || /net::ERR_ABORTED/.test(text) || /401/.test(text)) this.filtered.push(text);
        else this.consoleErrors.push(text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  resetErrors() {
    this.consoleErrors = [];
    this.exceptions = [];
    this.filtered = [];
  }

  errors() {
    return [...this.consoleErrors, ...this.exceptions];
  }
}

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`);
      const list = await res.json();
      for (const t of list) {
        if (t.type !== 'page') continue;
        try {
          if (new URL(t.url).origin !== BASE) continue;
        } catch {
          continue;
        }
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        try {
          await withTimeout(new Promise((r) => ws.addEventListener('open', r, { once: true })), 3000);
          const probe = new CDP(ws);
          await probe.send('Runtime.enable');
          const state = await evaluate(
            probe,
            `({ bad: /^(about:|chrome)/.test(location.href) || document.title === location.hostname, hasSite: Boolean(document.querySelector('.brand, .app-topbar, #webgl')) })`
          );
          ws.close();
          if (!state.bad && state.hasSite) return { wsUrl: t.webSocketDebuggerUrl, reused: true };
        } catch {
          try { ws.close(); } catch { /* ignore */ }
        }
      }
      const created = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' });
      if (created.ok) {
        const tab = await created.json();
        if (tab.webSocketDebuggerUrl) return { wsUrl: tab.webSocketDebuggerUrl, reused: false };
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error('无法连接 CDP，请确认 Chrome 以 --remote-debugging-port=9222 启动');
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (exceptionDetails) throw new Error(`页面执行异常: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
  return result.value;
}

async function waitFor(cdp, expression, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, expression);
      if (last && last.done) return last;
    } catch {
      /* 导航中上下文可能重建，继续重试 */
    }
    await sleep(intervalMs);
  }
  return last ?? { done: false };
}

async function navigate(cdp, url, expectPath) {
  cdp.resetErrors();
  await evaluate(cdp, 'window.__verifyNavMarker = 1').catch(() => {});
  await cdp.send('Page.navigate', { url });
  const nav = await waitFor(
    cdp,
    `({ done: typeof window.__verifyNavMarker === 'undefined' && document.readyState === 'complete' && location.pathname === ${JSON.stringify(expectPath)} && document.title !== location.hostname, path: location.pathname, title: document.title })`,
    30000
  );
  if (!nav.done) throw new Error(`导航未完成：${url}（当前路径 ${nav.path ?? '未知'}）`);
  await sleep(400);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function setCookie(cdp, value) {
  await cdp.send('Network.setCookie', {
    name: SESSION_COOKIE,
    value,
    url: `${BASE}/`,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax'
  });
}

async function clearCookies(cdp) {
  await cdp.send('Network.clearBrowserCookies');
}

/** 等会话区渲染完毕（非「会话加载中」），再断言入口的有无 */
async function waitSessionSettled(cdp) {
  return waitFor(
    cdp,
    `(() => {
      const chip = document.querySelector('#session-area .session-chip');
      const text = chip?.innerText ?? '';
      return { done: Boolean(chip) && !/加载中/.test(text), text, adminEntry: Boolean(document.getElementById('admin-entry')) };
    })()`,
    15000
  );
}

/** 读取 toast 栈当前提示 */
async function readToast(cdp) {
  return waitFor(
    cdp,
    `(() => {
      const item = document.querySelector('#toast-stack .toast');
      if (!item) return { done: false };
      return { done: true, text: item.textContent, tone: item.dataset.tone ?? '', url: location.search };
    })()`,
    8000
  );
}

/* ================================ 断言工具 ================================ */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${typeof detail === 'object' ? JSON.stringify(detail) : detail}` : ''}`);
}

/* ================================= 主流程 ================================= */

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  seedSessions();

  const { wsUrl, reused } = await getTarget();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  /* --------------- 1. 回调提示消费（匿名，login=ok） --------------- */
  await clearCookies(cdp);
  await navigate(cdp, `${BASE}/agents.html?login=ok`, '/agents.html');
  const okToast = await readToast(cdp);
  check('login=ok 显示登录成功提示', okToast.done && okToast.text.includes('登录成功'), okToast.text);
  check('login=ok 提示为成功色调', okToast.tone === 'success', okToast.tone);
  check('提示后地址栏登录参数被清理', !/login=/.test(okToast.url ?? ''), okToast.url);
  await shot(cdp, '01-agents-login-ok');

  /* --------------- 2. 退出提示（匿名，logout=1） --------------- */
  await navigate(cdp, `${BASE}/agents.html?logout=1`, '/agents.html');
  const logoutToast = await readToast(cdp);
  check('logout=1 显示退出提示', logoutToast.done && logoutToast.text.includes('已退出'), logoutToast.text);
  check('提示后地址栏退出参数被清理', !/logout=/.test(logoutToast.url ?? ''), logoutToast.url);

  /* --------------- 3. 错误提示（匿名，login_error） --------------- */
  await navigate(cdp, `${BASE}/agents.html?login_error=ticket_expired`, '/agents.html');
  const errToast = await readToast(cdp);
  check('login_error 显示中文错误提示', errToast.done && /票据已过期/.test(errToast.text), errToast.text);
  check('错误提示为告警色调', errToast.tone === 'error', errToast.tone);
  check('提示后地址栏错误参数被清理', !/login_error=/.test(errToast.url ?? ''), errToast.url);
  await shot(cdp, '02-agents-login-error');

  /* --------------- 4. 匿名态不显示管理端入口 --------------- */
  const anonSession = await waitSessionSettled(cdp);
  check('匿名态不显示管理端入口', anonSession.adminEntry === false, anonSession.text);

  /* --------------- 5. 管理员在查询平台显示入口并可跳转 --------------- */
  await setCookie(cdp, sessions[0].token);
  await navigate(cdp, `${BASE}/agents.html`, '/agents.html');
  const adminSession = await waitSessionSettled(cdp);
  check('管理员会话已生效', /Crow5 验证管理员/.test(adminSession.text), adminSession.text);
  check('管理员顶栏出现「管理端」入口', adminSession.adminEntry === true, adminSession.text);
  await shot(cdp, '03-agents-admin-entry');

  // 点击会立即触发导航、打断当前 evaluate，故只发点击、用轮询等待导航结果
  await evaluate(cdp, `document.getElementById('admin-entry').click()`).catch(() => {});
  const adminLanding = await waitFor(
    cdp,
    `(() => {
      if (location.pathname !== '/admin.html' || document.readyState !== 'complete') return { done: false, path: location.pathname };
      const content = document.getElementById('admin-content');
      return { done: !content.hidden, path: location.pathname, gateHidden: document.getElementById('gate').hidden };
    })()`,
    20000
  );
  check('点击入口跳转管理端', adminLanding.path === '/admin.html', adminLanding.path);
  check('管理员在管理端门禁放行（可新增）', adminLanding.done === true && adminLanding.gateHidden === true, adminLanding);
  await shot(cdp, '04-admin-allow');

  /* --------------- 6. 管理员在查询平台可看到错误提示且入口仍在 --------------- */
  await navigate(cdp, `${BASE}/agents.html?login_error=invalid_identity`, '/agents.html');
  const adminErrToast = await readToast(cdp);
  check('管理员同样消费错误提示', adminErrToast.done && /身份信息不完整/.test(adminErrToast.text), adminErrToast.text);
  const adminAfterErr = await waitSessionSettled(cdp);
  check('消费提示后管理端入口仍存在', adminAfterErr.adminEntry === true, adminAfterErr.text);

  /* --------------- 7. 普通用户在查询平台不显示入口 --------------- */
  await setCookie(cdp, sessions[1].token);
  await navigate(cdp, `${BASE}/agents.html`, '/agents.html');
  const userSession = await waitSessionSettled(cdp);
  check('普通用户会话已生效', /Crow5 验证普通用户/.test(userSession.text), userSession.text);
  check('普通用户顶栏无管理端入口', userSession.adminEntry === false, userSession.text);
  await shot(cdp, '05-agents-user-no-entry');

  /* --------------- 8. 普通用户直达管理端被拦截 --------------- */
  await navigate(cdp, `${BASE}/admin.html`, '/admin.html');
  const userGate = await waitFor(
    cdp,
    `(() => {
      const gate = document.getElementById('gate');
      return { done: !gate.hidden, title: document.getElementById('gate-title').textContent, contentHidden: document.getElementById('admin-content').hidden };
    })()`,
    10000
  );
  check('普通用户被管理端门禁拦截', userGate.done === true && userGate.title === '无管理员权限', userGate.title);
  check('普通用户不显示新增表单', userGate.contentHidden === true);
  await shot(cdp, '06-admin-user-blocked');

  /* --------------- 9. 控制台错误复查 --------------- */
  const errorsAfter = cdp.errors();
  check('全流程页面无未处理错误', errorsAfter.length === 0, errorsAfter.length ? errorsAfter : 'clean');

  /* ------------------------ 汇总 ------------------------ */
  const failed = results.filter((r) => !r.ok);
  const report = {
    meta: {
      baseUrl: BASE,
      reusedTarget: reused,
      filteredBenign: cdp.filtered,
      finishedAt: new Date().toISOString()
    },
    pass: failed.length === 0,
    summary: `${results.length - failed.length}/${results.length} 通过`,
    results
  };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n=== ${report.summary} ===`);

  const removed = cleanup();
  console.log('清理结果:', JSON.stringify(removed));

  ws.close();
  process.exit(report.pass ? 0 : 1);
})().catch((err) => {
  console.error('VERIFY FAILED:', err);
  try {
    cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
