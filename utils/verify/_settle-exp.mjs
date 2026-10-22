/**
 * 一次性收敛实验（跑完即删，非交付物）
 * 假设：3~6s 等待不足以让旋转 lerp 与粒子回弹完全收敛（fps≈14），
 *       导致「同状态静止对照」被高估。验证：等待 12s 后拍的两帧，帧间差应≈噪声。
 * 方法：单标签页长时序采样：噪声对 / 左侧对 / 右侧对 / 跨状态对。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';

const PAGE_URL = 'http://127.0.0.1:1002/';
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), 'utils', 'verify', 'shots', 'settle-exp');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:1002'));
if (!page) throw new Error('no target tab');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  writeFileSync(join(OUT, `${name}.png`), buf);
  return buf;
}
const mouse = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });

const CW = { x0: 0.4, y0: 0.425, x1: 0.6, y1: 0.575 };
function win(a, b, w) {
  const ch = a.channels, W = a.width;
  const x0 = Math.floor(W * w.x0), x1 = Math.ceil(W * w.x1);
  const y0 = Math.floor(a.height * w.y0), y1 = Math.ceil(a.height * w.y1);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * W + x) * ch;
    sum += Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
    n++;
  }
  return +(sum / n).toFixed(1);
}
const d = (a, b) => win(decodePng(a), decodePng(b), CW);

await send('Page.navigate', { url: PAGE_URL });
await sleep(6000);
await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
await sleep(4000);

console.log('== 长收敛实验（全部 8s 间隔拍摄）==');
const N0 = await shot('n0'); await sleep(8000);
const N1 = await shot('n1');
console.log('噪声 N0→N1:', d(N0, N1));

await mouse(250, 450); await sleep(12000);
const L0 = await shot('l0'); await sleep(8000);
const L1 = await shot('l1');
console.log('左侧 L0→L1（12s 收敛后，8s 帧距）:', d(L0, L1));

await mouse(1190, 450); await sleep(12000);
const R0 = await shot('r0'); await sleep(8000);
const R1 = await shot('r1');
console.log('右侧 R0→R1（12s 收敛后，8s 帧距）:', d(R0, R1));

console.log('视差 L0→R0:', d(L0, R0));
console.log('视差回程 R1→L1:', d(R1, L1));
console.log('跨: L1→R0:', d(L1, R0));

// 再等更久，测右侧更长收敛
await sleep(8000);
const R2 = await shot('r2');
console.log('右侧 R1→R2（再 8s）:', d(R1, R2));

ws.close();
process.exit(0);
