/**
 * 站点全链路 CDP 验证脚本（开发工具，非交付产物）
 *
 * 用途：用 Chrome DevTools Protocol 驱动真实浏览器，验证 agent-official-website
 * 三条页面主链路（首页 / 查询平台 / 管理端）在真实后端（2001）上的可用性：
 *
 *   1. 首页 index.html：加载无控制台错误；「Skip to Finale」按钮点击后滚动到底；
 *      登录区在匿名态显示登录入口；进入末幕后按钮淡出（is-hidden）
 *   2. 管理端 admin.html（注入管理员会话）：
 *      - 门禁放行、表单可见
 *      - 提交新增 → 提示成功 + 列表出现新行
 *      - 点击行 → 明细弹窗显示扩展字段；Esc 关闭
 *   3. 查询平台 agents.html：
 *      - 关键词检索命中新增记录（服务端 ?q=）
 *      - 点击卡片 → 详情弹窗展示扩展字段；点击遮罩关闭
 *      - 匿名态（清 Cookie）仍可检索（读接口公开）
 *   4. 管理端匿名态：显示「需要登录」门禁，不泄漏表单
 *
 * 安全说明：脚本为了验证「已登录管理员」链路，会向数据库写入一个
 * 临时会话（cookie 值随机生成，仅验证进程与本次浏览器知晓），并在结束时
 * 清理本次新增的测试数据（会话行 / 测试记录 / 首次创建的测试用户）。
 *
 * 运行：node utils/verify/cdp-site-verify.mjs [baseUrl]
 * 前置：后端已启动（node .preview-server.js）；Chrome 以 --remote-debugging-port=9222 启动
 * 产物：utils/verify/shots/site/（截图 + report.json）
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.argv[2] || 'http://127.0.0.1:2001';
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'site');
const DB_PATH = join(process.cwd(), 'database', 'agent-website.db');
const SESSION_COOKIE = 'agent_site_session';
const TEST_UID = 'crow5_verify_admin';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);
const now = () => Date.now();

/* ============================ 数据库准备 / 清理 ============================ */

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 4000;');

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');

const preexistingUser = db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(TEST_UID);
let testUserId = preexistingUser?.id ?? null;
const sessionExpiresAt = now() + 60 * 60 * 1000;
let sessionInserted = false;
const agentName = `Crow5 站点验证-${now()}`;

function seedSession() {
  const ts = now();
  if (!testUserId) {
    db.prepare(
      `INSERT INTO users (sso_uid, name, display_name, role, roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, 'admin', '["admin"]', '', '', 'Crow5 验证', 1, ?, ?, ?)`
    ).run(TEST_UID, TEST_UID, 'Crow5 验证管理员', ts, ts, ts);
    testUserId = db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(TEST_UID).id;
  }
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    testUserId,
    sessionExpiresAt,
    ts
  );
  sessionInserted = true;
}

function cleanup() {
  const removed = { sessions: 0, agents: 0, user: 0 };
  try {
    if (sessionInserted) {
      removed.sessions = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
    }
    removed.agents = db.prepare('DELETE FROM agents WHERE name = ?').run(agentName).changes;
    if (!preexistingUser && testUserId) {
      removed.user = db.prepare('DELETE FROM users WHERE id = ?').run(testUserId).changes;
    }
  } catch (err) {
    console.error('[cleanup] 清理异常:', err.message);
  }
  db.close();
  return removed;
}

/* ================================ CDP 封装 ================================ */

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`);
      const list = await res.json();
      // 仅复用「已成功加载本站页面」的标签：Chrome 错误页 / 空白页（body 文本为域名或该页无站点标记）不复用
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
        if (/favicon\.ico/i.test(text) || /net::ERR_ABORTED/.test(text)) this.filtered.push(text);
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

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (exceptionDetails) throw new Error(`页面执行异常: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
  return result.value;
}

async function waitFor(cdp, expression, timeoutMs = 20000, intervalMs = 300) {
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
  if (!nav.done) throw new Error(`导航未完成：${url}（当前路径 ${nav.path ?? '未知'}，标题 ${nav.title ?? '未知'}）`);
  const broken = await evaluate(cdp, `(/ERR_CONNECTION|无法访问此网站|拒绝了我们的连接请求/.test(document.body.innerText))`);
  if (broken) throw new Error(`页面加载失败（服务不可达）：${url}`);
  await sleep(600);
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

/* ================================ 断言工具 ================================ */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${typeof detail === 'object' ? JSON.stringify(detail) : detail}` : ''}`);
}

/* ================================= 主流程 ================================= */

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
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
  // 标签页在后台时 visibilityState=hidden：Chrome 会冻结平滑滚动与 :hover 处理。
  // 焦点模拟让后台标签按「可见可聚焦」运行，等价于真实用户前台操作，避免假阴性。
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  /* ------------------------ 1. 首页（匿名） ------------------------ */
  await clearCookies(cdp);
  await navigate(cdp, `${BASE}/`, '/');
  await sleep(2000);

  const homeErrors = cdp.errors();
  check('首页无控制台错误', homeErrors.length === 0, homeErrors.length ? homeErrors : 'clean');

  const homeDom = await evaluate(
    cdp,
    `({
      skipVisible: !document.getElementById('skip-to-finale').classList.contains('is-hidden'),
      dockState: document.getElementById('finale-dock').dataset.authState,
      loginHidden: document.getElementById('finale-login').hidden,
      canvas: Boolean(document.querySelector('#webgl canvas'))
    })`
  );
  check('首页 WebGL 画布已注入', homeDom.canvas === true);
  check('首页末幕登录区处于匿名态', homeDom.dockState === 'anonymous', homeDom.dockState);
  check('首页显示登录入口', homeDom.loginHidden === false);
  await shot(cdp, '01-home-top');

  const skipResult = await evaluate(
    cdp,
    `(async () => {
      const btn = document.getElementById('skip-to-finale');
      btn.click();
      await new Promise((r) => setTimeout(r, 2600));
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return {
        max,
        y: window.scrollY,
        progress: max > 0 ? window.scrollY / max : 0,
        btnHidden: btn.classList.contains('is-hidden')
      };
    })()`
  );
  check('Skip 按钮滚动到文档末尾', skipResult.progress > 0.9, skipResult);
  check('接近末幕后 Skip 按钮淡出', skipResult.btnHidden === true);
  await sleep(2200);
  await shot(cdp, '02-home-finale');

  const finalEntries = await evaluate(
    cdp,
    `Array.from(document.querySelectorAll('.finale-entries .finale-entry')).map((a) => a.textContent)`
  );
  check('末幕显示查询平台入口', finalEntries.includes('智能体查询平台'), finalEntries);

  /* ------------------------ 2. 管理端（管理员） ------------------------ */
  seedSession();
  await setCookie(cdp, token);
  await navigate(cdp, `${BASE}/admin.html`, '/admin.html');
  await sleep(1500);

  const adminGate = await waitFor(
    cdp,
    `(() => {
      const gate = document.getElementById('gate');
      const content = document.getElementById('admin-content');
      return { done: gate && !gate.hidden || content && !content.hidden, gateHidden: gate?.hidden, contentHidden: content?.hidden };
    })()`,
    10000
  );
  check('管理端门禁放行（管理员）', adminGate.contentHidden === false && adminGate.gateHidden === true, adminGate);

  const gateErrors = cdp.errors();
  check('管理端无控制台错误', gateErrors.length === 0, gateErrors.length ? gateErrors : 'clean');
  await shot(cdp, '03-admin-console');

  const submit = await evaluate(
    cdp,
    `(async () => {
      document.getElementById('field-name').value = ${JSON.stringify(agentName)};
      document.getElementById('field-summary').value = '由 CDP 验证脚本自动创建，用于校验管理端新增与查询平台检索链路。';
      document.getElementById('field-tags').value = 'Crow5验证,站点自检';
      document.getElementById('field-data').value = JSON.stringify({ 场景: '自动化验证', 能力: '新增/检索/明细', 级别: 'P0' });
      document.getElementById('form-submit').click();
      await new Promise((r) => setTimeout(r, 1500));
      const notice = document.getElementById('create-notice');
      return {
        noticeHidden: notice.hidden,
        noticeText: notice.textContent,
        noticeTone: notice.dataset.tone,
        // 名称单元格内含名称按钮 + 课程名副标题：按首行文本比对（去空白）
        rows: Array.from(document.querySelectorAll('#agent-rows .cell-name')).map((td) => td.textContent.trim().split('\\n')[0].trim()),
        toasts: Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent)
      };
    })()`
  );
  check('管理端提交新增返回成功提示', submit.noticeTone === 'success' && /新增成功/.test(submit.noticeText), submit.noticeText);
  check('管理端列表出现新增记录', submit.rows.includes(agentName), submit.rows.slice(0, 5));

  const detail = await evaluate(
    cdp,
    `(async () => {
      const row = Array.from(document.querySelectorAll('#agent-rows tr')).find((tr) => tr.querySelector('.cell-name')?.textContent.trim().startsWith(${JSON.stringify(agentName)}));
      row.click();
      await new Promise((r) => setTimeout(r, 800));
      const backdrop = document.getElementById('detail-backdrop');
      const body = document.getElementById('detail-body');
      const state = { open: !backdrop.hidden, title: document.getElementById('detail-title').textContent, text: body.innerText };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      state.closedByEsc = backdrop.hidden;
      return state;
    })()`
  );
  check('管理端明细弹窗打开', detail.open === true, detail.title);
  check('管理端明细含扩展字段', /自动化验证/.test(detail.text) && /P0/.test(detail.text));
  check('管理端明细 Esc 可关闭', detail.closedByEsc === true);
  await shot(cdp, '04-admin-detail');

  /* ------------------------ 3. 查询平台（管理员 + 检索） ------------------------ */
  await navigate(cdp, `${BASE}/agents.html`, '/agents.html');
  await sleep(1200);

  const direct = await evaluate(
    cdp,
    `({ count: document.querySelectorAll('.agent-card').length, meta: document.getElementById('result-meta').innerText })`
  );
  check('查询平台首屏列出记录', direct.count > 0, direct.meta);

  const search = await evaluate(
    cdp,
    `(async () => {
      const input = document.getElementById('search-input');
      input.value = 'Crow5验证';
      document.getElementById('search-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      const cards = Array.from(document.querySelectorAll('.agent-card'));
      return {
        meta: document.getElementById('result-meta').innerText,
        names: cards.map((c) => c.querySelector('.agent-card-name').textContent),
        firstText: cards[0]?.innerText ?? ''
      };
    })()`
  );
  check('检索命中新增记录', search.names.includes(agentName), search.meta);
  check('检索结果含标签渲染', /站点自检/.test(search.firstText));

  // 按钮 hover 反馈：真实鼠标移动 + 多属性快照（hover 只改 border/color/shadow，不改 background）
  const hoverSnap = `(() => {
    const s = getComputedStyle(document.getElementById('search-submit'));
    return [s.borderTopColor, s.color, s.boxShadow].join(' | ');
  })()`;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
  await sleep(400);
  const hoverBefore = await evaluate(cdp, hoverSnap);
  const hoverTarget = await evaluate(
    cdp,
    `(() => {
      const r = document.getElementById('search-submit').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverTarget.x, y: hoverTarget.y });
  await sleep(400);
  const hoverAfter = await evaluate(cdp, hoverSnap);
  check('按钮 hover 有视觉反馈', hoverBefore !== hoverAfter, { before: hoverBefore, after: hoverAfter });
  await shot(cdp, '05-agents-search');

  const card = await evaluate(
    cdp,
    `(async () => {
      const target = Array.from(document.querySelectorAll('.agent-card')).find((c) => c.querySelector('.agent-card-name').textContent === ${JSON.stringify(agentName)});
      target.click();
      await new Promise((r) => setTimeout(r, 500));
      const backdrop = document.getElementById('detail-backdrop');
      const state = { open: !backdrop.hidden, title: document.getElementById('detail-title').textContent, text: document.getElementById('detail-body').innerText };
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      state.closedByBackdrop = backdrop.hidden;
      return state;
    })()`
  );
  check('查询平台详情弹窗打开', card.open === true, card.title);
  check('查询平台详情含扩展字段', /自动化验证/.test(card.text));
  check('点击遮罩可关闭详情', card.closedByBackdrop === true);
  await shot(cdp, '06-agents-detail');

  /* ------------------------ 4. 匿名态复查 ------------------------ */
  await clearCookies(cdp);
  await navigate(cdp, `${BASE}/admin.html`, '/admin.html');
  await sleep(1200);
  const anonAdmin = await evaluate(
    cdp,
    `({
      gateHidden: document.getElementById('gate').hidden,
      gateTitle: document.getElementById('gate-title').textContent,
      contentHidden: document.getElementById('admin-content').hidden,
      formVisible: Boolean(document.querySelector('#create-form')) && !document.getElementById('admin-content').hidden
    })`
  );
  check('匿名访问管理端被拦截', anonAdmin.contentHidden === true && anonAdmin.gateHidden === false, anonAdmin.gateTitle);
  check('匿名态不显示新增表单', anonAdmin.formVisible === false);
  await shot(cdp, '07-admin-anonymous');

  await navigate(cdp, `${BASE}/agents.html`, '/agents.html');
  await sleep(1200);
  const anonAgents = await evaluate(
    cdp,
    `({ count: document.querySelectorAll('.agent-card').length, chip: document.querySelector('.session-chip')?.innerText ?? '' })`
  );
  check('匿名访问查询平台可读', anonAgents.count > 0, anonAgents);
  await shot(cdp, '08-agents-anonymous');

  /* ------------------------ 5. 接口边界复查（匿名写必须 401/403） ------------------------ */
  const guard = await evaluate(
    cdp,
    `(async () => {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: '不该被创建' })
      });
      const read = await fetch('/api/agents', { credentials: 'same-origin' });
      return { writeStatus: res.status, readStatus: read.status };
    })()`
  );
  check('匿名写接口被拒绝', guard.writeStatus === 401 || guard.writeStatus === 403, guard);
  check('匿名读接口保持开放', guard.readStatus === 200, guard);

  const errorsAfter = cdp.errors().filter((e) => !/401/.test(e)); // 匿名写探测的 401 属预期结果
  check('全流程页面无未处理错误', errorsAfter.length === 0, errorsAfter.length ? errorsAfter : 'clean');

  /* ------------------------ 汇总 ------------------------ */
  const failed = results.filter((r) => !r.ok);
  const report = {
    meta: {
      baseUrl: BASE,
      agentName,
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
