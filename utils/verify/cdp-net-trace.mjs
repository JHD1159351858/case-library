/**
 * 认证中心授权入口完整网络抓包（开发工具）
 *
 * 用途：导航到认证中心授权入口，打印所有请求/响应/失败事件，
 * 用于定位「已登录但未回跳」的真实跳转链。
 *
 * 用法：node utils/verify/cdp-net-trace.mjs "<完整授权入口 URL>"
 */
const CDP_HTTP = 'http://127.0.0.1:9222';
const url = process.argv[2];

if (!url) {
  console.error('用法: node utils/verify/cdp-net-trace.mjs <授权入口完整 URL>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const tab = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const p = msg.params;
    if (p.redirectResponse) {
      events.push(`[REDIRECT ${p.redirectResponse.status}] ${p.redirectResponse.url}`);
      events.push(`        → ${p.request.url}`);
    } else {
      events.push(`[REQ] ${p.request.url}`);
    }
  }
  if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    events.push(`[RES ${r.status}] ${r.url}  (${msg.params.type})`);
  }
  if (msg.method === 'Network.loadingFailed') {
    events.push(`[FAIL] ${msg.params.errorText}  (${msg.params.type})`);
  }
  if (msg.method === 'Page.frameNavigated') {
    events.push(`[NAV] ${msg.params.frame.url}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

console.log('导航到:', url, '\n');
await send('Page.navigate', { url });
await sleep(8000);

console.log(events.join('\n'));
const final = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
console.log('\n最终落点:', final.result?.value);
ws.close();
