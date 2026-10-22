/**
 * 认证中心 return_to 白名单探测（开发工具）
 *
 * 用途：在认证中心已登录态下，导航到授权入口并抓取完整重定向链，
 * 判断某个 return_to origin 是否通过认证中心白名单。
 *
 * 判定：
 *   通过 → 最终落回目标 origin（307 → 目标地址）
 *   未通过 → 落在认证中心首页或 0.0.0.0:5000 等 fallback 地址
 *
 * 用法：node utils/verify/cdp-probe-return-to.mjs <return_to 完整回调地址>
 * 前置：Chrome 带 --remote-debugging-port=9222、认证中心处于已登录态
 */
const CDP_HTTP = 'http://127.0.0.1:9222';
const CENTER = process.env.SSO_CENTER_URL || 'https://sdtqvk3ybm.coze.site';
const target = process.argv[2];

if (!target) {
  console.error('用法: node utils/verify/cdp-probe-return-to.mjs <return_to 完整回调地址>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
let tab = list.find((t) => t.type === 'page' && t.url.startsWith(CENTER));
if (!tab) tab = list.find((t) => t.type === 'page');

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const chain = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
    return;
  }
  if (msg.method === 'Network.responseReceived') {
    const { response } = msg.params;
    if (response.url.startsWith(CENTER) && response.status >= 300 && response.status < 400) {
      chain.push({ status: response.status, from: response.url, to: response.headers?.location ?? response.headers?.Location ?? '(无)' });
    }
  }
  if (msg.method === 'Network.requestWillBeSent' && msg.params.redirectResponse) {
    const { response } = msg.params.redirectResponse;
    const fromUrl = response?.url ?? '';
    if (fromUrl.startsWith(CENTER)) {
      chain.push({ status: response.status, from: fromUrl, to: msg.params.request?.url ?? '(无)' });
    }
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

const url = `${CENTER}/api/auth/chaoxing?return_to=${encodeURIComponent(target)}`;
console.log('探测目标 return_to:', target);
console.log('授权入口:', url, '\n');

await send('Page.navigate', { url });
await sleep(6000);

const final = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });

console.log('重定向链:');
if (!chain.length) console.log('  （未捕获到认证中心 3xx 响应）');
chain.forEach((c, i) => {
  console.log(`  [${i + 1}] ${c.status}  ${c.from.slice(0, 90)}`);
  console.log(`        → ${String(c.to).slice(0, 130)}`);
});
console.log('\n最终落点:', final.result?.value);
ws.close();
