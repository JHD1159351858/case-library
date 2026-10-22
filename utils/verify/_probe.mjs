/**
 * 一次性信噪比探针（跑完即删，不属于交付物）
 * 目的：确定「视差信号 / 星云噪声」在哪个窗口、哪种度量下分离度最大
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';

const PAGE_URL = 'http://127.0.0.1:1002/';
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), 'utils', 'verify', 'shots', 'probe');
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
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  writeFileSync(join(OUT, `${name}.png`), buf);
  return buf;
}
async function mouse(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
}

function win(a, b, w) {
  const A = decodePng(a);
  const B = decodePng(b);
  const ch = A.channels;
  const W = A.width;
  const H = A.height;
  const x0 = Math.floor(W * w.x0), x1 = Math.ceil(W * w.x1);
  const y0 = Math.floor(H * w.y0), y1 = Math.ceil(H * w.y1);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * ch;
      sum += Math.abs(A.data[p] - B.data[p]) + Math.abs(A.data[p + 1] - B.data[p + 1]) + Math.abs(A.data[p + 2] - B.data[p + 2]);
      n++;
    }
  return +(sum / n).toFixed(2);
}

function blocks(a, b, nx = 3, ny = 3) {
  const out = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      out.push(win(a, b, { x0: i / nx, y0: j / ny, x1: (i + 1) / nx, y1: (j + 1) / ny }));
  return out;
}

const W = {
  full: { x0: 0, y0: 0, x1: 1, y1: 1 },
  center: { x0: 0.15, y0: 0.25, x1: 0.85, y1: 0.6 },
  core: { x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.65 }
};

const out = {};

// 导航到干净状态
await send('Page.navigate', { url: PAGE_URL });
await sleep(6000);
await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
await sleep(3500);

const P0 = await shot('p0');
await sleep(5000);
const P1 = await shot('p1');
out.noise = { full: win(P0, P1, W.full), center: win(P0, P1, W.center), core: win(P0, P1, W.core), blocks: blocks(P0, P1) };

await mouse(250, 450);
await sleep(4000);
const L0 = await shot('l0');
await sleep(4000);
const L1 = await shot('l1');
out.contact = { full: win(L0, L1, W.full), center: win(L0, L1, W.center), core: win(L0, L1, W.core) };

await mouse(1190, 450);
await sleep(4000);
const R0 = await shot('r0');
out.parallax = { full: win(L0, R0, W.full), center: win(L0, R0, W.center), core: win(L0, R0, W.core), blocks: blocks(L0, R0) };

await mouse(100, 450);
await sleep(4000);
const LL = await shot('ll');
await mouse(1325, 450);
await sleep(4000);
const RR = await shot('rr');
out.parallaxExtreme = { full: win(LL, RR, W.full), center: win(LL, RR, W.center), core: win(LL, RR, W.core), blocks: blocks(LL, RR) };

console.log(JSON.stringify(out, null, 2));
writeFileSync(join(OUT, 'probe.json'), JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
