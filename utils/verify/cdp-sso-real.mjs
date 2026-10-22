/**
 * 真实认证中心 SSO 联调脚本（开发工具，非交付产物）
 *
 * 用途：驱动真实 Chrome（--remote-debugging-port=9222）访问本站登录入口，
 * 走「本站 → 认证中心 → 超星 OAuth → 认证中心回调 → 本站回调 → 建会话」完整链路，
 * 并在每个阶段截图 + 记录 URL / 页面状态，便于联调观察与留痕。
 *
 * 模式：
 *   node utils/verify/cdp-sso-real.mjs watch          仅导航到登录入口并持续观察（人工完成超星登录）
 *   node utils/verify/cdp-sso-real.mjs done [retries] 轮询等待回调完成并验证登录态
 *   node utils/verify/cdp-sso-real.mjs check          直接检查当前登录态（/api/auth/me + 页面）
 *   node utils/verify/cdp-sso-real.mjs logout         执行登出并观察联动
 *
 * 前置：后端已启动（node .preview-server.js）、Chrome 带调试端口运行
 * 产物：utils/verify/shots/sso/（截图 + report.json）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.SSO_SITE || 'http://127.0.0.1:2001';
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'sso');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

let step = 0;
const shot = async (cdp, name) => {
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    step += 1;
    const file = join(OUT_DIR, `${String(step).padStart(2, '0')}-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  } catch {
    return null;
  }
};

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function connect() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  const list = await res.json();
  let tab = list.find((t) => t.type === 'page' && !/^(devtools|chrome)/.test(t.url));
  if (!tab) {
    const created = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    tab = await created.json();
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

async function snapshot(cdp, label) {
  const state = await evaluate(
    cdp,
    `({
       url: location.href,
       path: location.pathname,
       host: location.host,
       title: document.title.slice(0, 80),
       bodyText: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) : '',
       hasSiteMark: Boolean(document.querySelector('.brand, .app-topbar, #webgl')),
       loginBtn: Boolean(document.querySelector('a[href*="chaoxing/start"], a[href*="/api/auth"]')),
       userChip: document.querySelector('.session-chip, [data-session]')?.innerText?.slice(0, 80) ?? null
     })`
  ).catch((err) => ({ url: '（执行失败）', error: err.message }));
  const file = await shot(cdp, label);
  console.log(`[${label}] ${state.url}`);
  if (state.title) console.log(`  标题: ${state.title}`);
  if (state.bodyText) console.log(`  正文: ${state.bodyText.slice(0, 220)}`);
  if (file) console.log(`  截图: ${file}`);
  return state;
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await sleep(2500);
}

async function waitForUrl(cdp, match, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, 'location.href');
      if (match(last)) return last;
    } catch { /* navigating */ }
    await sleep(1200);
  }
  return last;
}

const mode = process.argv[2] || 'watch';

const cdp = await connect();
const report = { mode, base: BASE, steps: [] };

try {
  if (mode === 'watch') {
    const startUrl = `${BASE}/api/auth/chaoxing/start`;
    console.log(`导航到本站登录入口：${startUrl}`);
    await navigate(cdp, startUrl);
    report.steps.push(await snapshot(cdp, 'chaoxing-start'));

    await waitForUrl(cdp, (u) => !/^http:\/\/127\.0\.0\.1:2001/.test(u), 30000);
    report.steps.push(await snapshot(cdp, 'redirected'));

    const state = report.steps.at(-1);
    console.log('\n===== 请在浏览器窗口中完成超星登录 =====');
    console.log('完成后运行：node utils/verify/cdp-sso-real.mjs done');
    console.log(`当前落点：${state.url}`);
  }

  if (mode === 'done') {
    const retries = Number(process.argv[3] ?? 120);
    const after = await waitForUrl(cdp, (u) => u.startsWith(BASE) && !/chaoxing\/start/.test(u), retries * 1000);
    report.steps.push(await snapshot(cdp, 'callback-landing'));

    const me = await evaluate(
      cdp,
      `fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.json()).catch(e => ({ error: String(e) }))`
    );
    report.me = me;
    console.log('\n/api/auth/me =>', JSON.stringify(me));

    const me2 = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: await cookieHeader(cdp) } }).then((r) => r.json());
    report.meServerSide = me2;
    console.log('服务端会话校验 =>', JSON.stringify(me2));

    await navigate(cdp, `${BASE}/`);
    report.steps.push(await snapshot(cdp, 'home-after-login'));
  }

  if (mode === 'check') {
    const cookie = await cookieHeader(cdp);
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } }).then((r) => r.json());
    console.log('浏览器 Cookie =>', cookie.replace(/=(.{8}).*?(;|$)/g, '=$1…$2'));
    console.log('/api/auth/me =>', JSON.stringify(me, null, 2));
    report.me = me;
    report.steps.push(await snapshot(cdp, 'current-page'));
  }

  if (mode === 'resume') {
    const center = process.env.SSO_CENTER_URL || 'https://sdtqvk3ybm.coze.site';
    const callback = `${BASE}/api/auth/chaoxing/callback`;
    const url = `${center}/api/auth/chaoxing?return_to=${encodeURIComponent(callback)}`;
    console.log('重新触发认证中心授权（此时中心已有会话）：', url);
    await cdp.send('Page.navigate', { url });
    const chain = [];
    let last = '';
    for (let i = 0; i < 40; i++) {
      const href = await evaluate(cdp, 'location.href').catch(() => last);
      if (href && href !== last) {
        chain.push(href);
        last = href;
        console.log(`  [${i}] ${href}`);
      }
      if (href.startsWith(BASE) && !/chaoxing\/start/.test(href)) break;
      await sleep(800);
    }
    report.chain = chain;
    report.steps.push(await snapshot(cdp, 'resume-landing'));
    const me = await evaluate(
      cdp,
      `fetch('/api/auth/me', { credentials: 'same-origin' }).then(r => r.json()).catch(e => ({ error: String(e) }))`
    ).catch((err) => ({ error: err.message }));
    report.me = me;
    console.log('/api/auth/me =>', JSON.stringify(me));
  }

  if (mode === 'logout') {
    const before = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: await cookieHeader(cdp) } }).then((r) => r.json());
    console.log('登出前 =>', JSON.stringify(before));
    const res = await evaluate(
      cdp,
      `fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(r => r.json()).catch(e => ({ error: String(e) }))`
    );
    console.log('本站登出 =>', JSON.stringify(res));
    report.logout = res;
    if (res?.logoutUrl) {
      console.log('跳转认证中心登出地址：', res.logoutUrl);
      await navigate(cdp, res.logoutUrl);
      report.steps.push(await snapshot(cdp, 'center-after-logout'));
    }
    const after = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: await cookieHeader(cdp) } }).then((r) => r.json());
    console.log('登出后 =>', JSON.stringify(after));
    report.after = after;
  }
} finally {
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  cdp.close();
}

async function cookieHeader(cdp) {
  const { cookies } = await cdp.send('Network.getCookies', { urls: [BASE] }).catch(async () => {
    await cdp.send('Network.enable');
    return cdp.send('Network.getCookies', { urls: [BASE] });
  });
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
