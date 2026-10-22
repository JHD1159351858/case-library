/**
 * 临时交叉验证：Node 解码统计 vs Chrome 解码统计（同一张 PNG）
 * 跑完即删，不属于交付物。
 */
import { readFileSync } from 'node:fs';
import { decodePng, analyzePixels } from './png.mjs';

const buf = readFileSync('utils/verify/shots/pc-00-start.png');
const nodeStats = analyzePixels(decodePng(buf));
const b64 = buf.toString('base64');

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
});
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

const { result } = await send('Runtime.evaluate', {
  expression: `(async () => {
    const res = await fetch('data:image/png;base64,${b64}');
    const bmp = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const w = bmp.width, h = bmp.height;
    const x0 = Math.max(0, Math.floor(w * 0.15)), x1 = Math.min(w, Math.ceil(w * 0.85));
    const y0 = Math.max(0, Math.floor(h * 0.25)), y1 = Math.min(h, Math.ceil(h * 0.60));
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let nonBlack = 0, sum = 0, total = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + d[i + 1] + d[i + 2];
      sum += v;
      if (v > 24) nonBlack++;
      total++;
    }
    return { w, h, sampled: total, nonBlack, ratio: +(nonBlack / total).toFixed(4), avg: +(sum / total).toFixed(2) };
  })()`,
  awaitPromise: true,
  returnByValue: true
});

console.log('NODE  :', JSON.stringify(nodeStats));
console.log('CHROME:', JSON.stringify(result.value));
const ok =
  nodeStats.sampled === result.value.sampled &&
  nodeStats.nonBlack === result.value.nonBlack;
console.log(ok ? 'CROSS-CHECK PASSED' : 'CROSS-CHECK MISMATCH');
ws.close();
process.exit(ok ? 0 : 1);
