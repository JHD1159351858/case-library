/**
 * 一次性鼠标视差验证探针（跑完即删，不属于交付物）
 * 原理：CDP Debugger 在 scene.js 视差赋值行设断点，
 *       直读 pointerNDC 与 facePoints.rotation 的真实数值，规避像素噪声。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_URL = 'http://127.0.0.1:1002/';
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT = join(process.cwd(), 'utils', 'verify', 'shots', 'probe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:1002'));
if (!page) throw new Error('no target tab on :1002');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0;
let latestScene = null;
const pending = new Map();
const waiters = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const cb = pending.get(m.id);
    pending.delete(m.id);
    cb(m);
    return;
  }
  if (m.method === 'Debugger.scriptParsed' && /scene\.js/.test(m.params.url || '')) {
    latestScene = m.params;
  }
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(m)) {
      const w = waiters.splice(i, 1)[0];
      w.resolve(m);
    }
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const waitEvent = (match, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    const entry = {
      match,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      }
    };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error(`event timeout ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.push(entry);
  });

const mouse = (x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });

// —— 准备：重载拿全新脚本实例，收集 scriptParsed ——
await send('Debugger.enable');
await send('Page.navigate', { url: PAGE_URL });
await sleep(6000);
await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
await sleep(3000);

if (!latestScene) throw new Error('scene.js script not parsed');
const scriptId = latestScene.scriptId;
const { scriptSource } = await send('Debugger.getScriptSource', { scriptId });
const lines = scriptSource.split('\n');
const bpLine = lines.findIndex((l) => l.includes('facePoints.rotation.y = lerp3(targetY'));
if (bpLine < 0) throw new Error('breakpoint line not found in scene.js');

const view = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({ w: innerWidth, h: innerHeight, y: scrollY })',
  returnByValue: true
});
const viewport = JSON.parse(view.result.value);
console.log('viewport:', JSON.stringify(viewport), '| bp:', bpLine);

const EXPR = `JSON.stringify({
  ndcx:Number(pointerNDC.x.toFixed(4)), ndcy:Number(pointerNDC.y.toFixed(4)),
  active:pointerActive,
  rx:Number(facePoints.rotation.x.toFixed(4)), ry:Number(facePoints.rotation.y.toFixed(4)),
  tX:Number((pointerActive?-(0.22*pointerNDC.y):0).toFixed(4)),
  tY:Number((pointerActive?0.22*pointerNDC.x:0).toFixed(4))
})`;

async function sample(label) {
  const rec = { label };
  const { breakpointId } = await send('Debugger.setBreakpoint', {
    location: { scriptId, lineNumber: bpLine }
  });
  try {
    const ev = await waitEvent((m) => m.method === 'Debugger.paused');
    const cf = ev.params.callFrames.find((f) => f.location.scriptId === scriptId) || ev.params.callFrames[0];
    const r = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: cf.callFrameId,
      expression: EXPR,
      returnByValue: true
    });
    rec.value = JSON.parse(r.result.value);
  } catch (e) {
    rec.error = String(e.message || e);
  } finally {
    try { await send('Debugger.removeBreakpoint', { breakpointId }); } catch {}
    try { await send('Debugger.resume'); } catch {}
  }
  console.log(label, rec.value ? JSON.stringify(rec.value) : rec.error);
  return rec;
}

// —— 实验序列 ——
const S = [];
S.push(await sample('S0_initial'));

await mouse(200, 450);
await sleep(2500);
S.push(await sample('S1_left'));

await mouse(1225, 450);
await sleep(2500);
S.push(await sample('S2_right'));

await mouse(200, 450);
await sleep(2500);
S.push(await sample('S3_left_again'));

await mouse(750, 150);
await sleep(2500);
S.push(await sample('S4_top'));

// —— 判定 ——
const by = Object.fromEntries(S.filter((s) => s.value).map((s) => [s.label, s.value]));
const near = (a, b, eps) => Math.abs(a - b) < eps;
const checks = {
  pointer_active_after_move: !!(by.S1_left && by.S1_left.active),
  left_direction: !!(by.S1_left && by.S1_left.ry < -0.08),
  right_direction: !!(by.S2_right && by.S2_right.ry > 0.08),
  bidirectional_range: !!(by.S1_left && by.S2_right && by.S2_right.ry - by.S1_left.ry > 0.15),
  converged_left: !!(by.S1_left && near(by.S1_left.ry, by.S1_left.tY, 0.03)),
  converged_right: !!(by.S2_right && near(by.S2_right.ry, by.S2_right.tY, 0.03)),
  reversible: !!(by.S1_left && by.S3_left_again && near(by.S1_left.ry, by.S3_left_again.ry, 0.03)),
  vertical_axis: !!(by.S4_top && by.S4_top.rx < -0.08 && near(by.S4_top.rx, by.S4_top.tX, 0.03))
};
const pass = Object.values(checks).every(Boolean);

const out = { viewport, bpLine, samples: S, checks, pass };
writeFileSync(join(OUT, 'mouse-verify.json'), JSON.stringify(out, null, 2));
console.log('\nCHECKS', JSON.stringify(checks, null, 2));
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');

ws.close();
process.exit(pass ? 0 : 1);
