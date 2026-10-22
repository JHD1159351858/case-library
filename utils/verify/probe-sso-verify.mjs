/**
 * 认证中心验票响应探测 v2（开发工具）
 *
 * 用途：在浏览器上下文（含完整会话 cookie）里走授权入口拿到一次性 ticket，
 * 再用 Node 直接调用认证中心 /api/sso/verify，打印原始身份 JSON，
 * 用于定位本站解析 invalid_identity 的字段差异。
 *
 * 关键设计：return_to 指向本站首页（非回调接口），因此 ticket 不会被本站消费，
 * 可从地址栏安全提取后独立使用。
 *
 * 用法：node utils/verify/probe-sso-verify.mjs
 */
import { readFileSync } from 'node:fs';

const CDP_HTTP = 'http://127.0.0.1:9222';
const CENTER = process.env.SSO_CENTER_URL || 'https://sdtqvk3ybm.coze.site';
const SAFE_RETURN = 'http://127.0.0.1:2001/';

const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const secret = envText.match(/^SSO_SHARED_SECRET=(.*)$/m)?.[1]?.trim();
if (!secret) {
  console.error('.env 缺少 SSO_SHARED_SECRET');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const tab = list.find((t) => t.type === 'page') ?? list[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');

const authUrl = `${CENTER}/api/auth/chaoxing?return_to=${encodeURIComponent(SAFE_RETURN)}`;
console.log('浏览器导航到授权入口（return_to 指向首页，不消费票据）:');
console.log('  ', authUrl, '\n');

await send('Page.navigate', { url: authUrl });
await sleep(6000);

const { result } = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
const finalUrl = result?.value ?? '';
console.log('最终落点:', finalUrl, '\n');

const ticket = new URL(finalUrl).searchParams.get('ticket');
if (!ticket) {
  console.log('未拿到 ticket。可能：认证中心会话已过期（需重新走超星登录）。');
  ws.close();
  process.exit(0);
}
ws.close();
console.log('ticket:', ticket.slice(0, 14) + '…\n');

const verifyRes = await fetch(`${CENTER}/api/sso/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticket, secret })
});

console.log('验票 HTTP 状态:', verifyRes.status);
const text = await verifyRes.text();
console.log('\n===== 原始响应 =====');
console.log(text.slice(0, 1200));
console.log('====================\n');

try {
  const json = JSON.parse(text);
  console.log('顶层 keys:', Object.keys(json).join(', ') || '(空对象)');
  for (const k of ['uid', 'userId', 'userid', 'user_id', 'sub']) {
    if (json[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(json[k])}`);
  }
  if (json.user && typeof json.user === 'object') console.log('嵌套 user keys:', Object.keys(json.user).join(', '));
  if (json.data && typeof json.data === 'object') console.log('嵌套 data keys:', Object.keys(json.data).join(', '));
  if (json.identity && typeof json.identity === 'object') console.log('嵌套 identity keys:', Object.keys(json.identity).join(', '));
} catch {
  console.log('（响应不是 JSON）');
}
