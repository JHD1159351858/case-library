/**
 * 验收关闭验证脚本（一次性工具，非交付产物）
 *
 * 目标（对应 2 个验收遗留确认项）：
 *   A. 移动端 375 宽度 P3 相位"叠影"定性
 *      - 视口 375x812，滚动到 t=0.70 指定位置，等待收敛（帧收敛轮询，≥2s）
 *      - 截图 + 读取 P2/P3 computed opacity / transform / rect
 *      - 同 session 间隔 2s 双子帧 diff 证明静止稳定
 *      - 补测 t=0.80（规范 0.78~0.84 P3 完全可见平台期）对照
 *   B. 导航点击行为（div 仅 hover，无跳转）与参考一致性
 *      - 合成真实鼠标点击（pressed+released），检测 URL 变化 / 文档重载 / 控制台报错 / DOM 异常
 *
 * 前置：Chrome --remote-debugging-port=9222；静态服务 127.0.0.1:1002
 * 运行：node utils/verify/_closeout.mjs
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';

const PAGE_URL = 'http://127.0.0.1:1002/';
const OUT_DIR = join(process.cwd(), 'utils', 'verify', 'shots');
const CDP_HTTP = 'http://127.0.0.1:9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- CDP 基础（与 cdp-verify.mjs 既有方式一致） ---------- */
async function getWsTarget(pageUrl) {
  const origin = new URL(pageUrl).origin;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`);
      const list = await res.json();
      const page = list.find((t) => {
        if (t.type !== 'page') return false;
        try { return new URL(t.url).origin === origin; } catch { return false; }
      });
      if (page) return { wsUrl: page.webSocketDebuggerUrl, id: page.id, reused: true };
      const created = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
      if (created.ok) {
        const tab = await created.json();
        if (tab.webSocketDebuggerUrl) return { wsUrl: tab.webSocketDebuggerUrl, id: tab.id, reused: false };
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('无法连接 CDP 9222');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.consoleErrors = []; this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) {
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          this.exceptions.push(d.exception?.description || d.text);
        }
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
          this.consoleErrors.push(`[log] ${msg.params.entry.text}`);
        }
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
}

async function connect(pageUrl) {
  const { wsUrl, id, reused } = await getWsTarget(pageUrl);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new CDP(ws);
  cdp.reusedTarget = reused; cdp.targetId = id;
  return cdp;
}

const evalJs = async (cdp, expression) => {
  const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.value;
};

async function waitFor(cdp, expression, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evalJs(cdp, expression);
      if (last && last.done) return last;
    } catch { /* 导航中上下文暂不可用 */ }
    await sleep(intervalMs);
  }
  return last;
}

async function capture(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, buf);
  return { buf, file };
}

async function scrollTo(cdp, progress, settleMs) {
  const r = await evalJs(cdp, `(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, max * ${progress});
    return { max, targetY: Math.round(max * ${progress}), y: window.scrollY };
  })()`);
  await sleep(settleMs);
  return r;
}

/** 相位状态采样：computed opacity/transform + rect + 标题到段落间距 */
async function phaseState(cdp, sel) {
  return evalJs(cdp, `(() => {
    const el = document.querySelector('${sel}');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const t = el.querySelector('.title-xl, .title-lg');
    const c = el.querySelector('.copy');
    const tr = t ? t.getBoundingClientRect() : null;
    const cr = c ? c.getBoundingClientRect() : null;
    return {
      styleOpacity: el.style.opacity,
      computedOpacity: cs.opacity,
      styleTransform: el.style.transform,
      computedTransform: cs.transform,
      inlinePointerEvents: el.style.pointerEvents,
      rect: { y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1) },
      titleRect: tr ? { y: +tr.y.toFixed(1), bottom: +tr.bottom.toFixed(1) } : null,
      copyRect: cr ? { y: +cr.y.toFixed(1), bottom: +cr.bottom.toFixed(1) } : null,
      titleGapToCopyPx: (tr && cr) ? +(cr.y - tr.bottom).toFixed(1) : null
    };
  })()`);
}

/** 帧间 diff（窗口化）：meanAbs 0~765；changedRatio 差>24 的像素占比 */
function diffStats(bufA, bufB, win = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
  const a = decodePng(bufA); const b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return { error: `size mismatch ${a.width}x${a.height}ch${a.channels} vs ${b.width}x${b.height}ch${b.channels}` };
  }
  const ch = a.channels; const w = a.width; const h = a.height;
  const x0 = Math.floor(w * win.x0); const x1 = Math.ceil(w * win.x1);
  const y0 = Math.floor(h * win.y0); const y1 = Math.ceil(h * win.y1);
  let sum = 0; let changed = 0; let total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * w + x) * ch;
    const d = Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
    sum += d; if (d > 24) changed++; total++;
  }
  return { meanAbs: +(sum / total).toFixed(3), changedRatio: +(changed / total).toFixed(4) };
}

const numOf = (s) => { const m = String(s).match(/-?[\d.]+/g); return m ? parseFloat(m[m.length - 1]) : NaN; };
const settled = (a, b) => {
  if (!a || !b) return false;
  const oa = parseFloat(a.computedOpacity); const ob = parseFloat(b.computedOpacity);
  return Math.abs(oa - ob) < 0.002 &&
    Math.abs(numOf(a.styleTransform) - numOf(b.styleTransform)) < 0.02;
};

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const cdp = await connect(PAGE_URL);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  // 视口 375x812（与既有脚本移动端模式一致：mobile:false，DPR 1）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Runtime.evaluate', { expression: 'window.__closeoutNavMarker = 1' });
  await cdp.send('Page.navigate', { url: PAGE_URL });
  const nav = await waitFor(cdp, `({ done: (typeof window.__closeoutNavMarker === 'undefined') && document.readyState === 'complete' })`);
  if (!nav || !nav.done) throw new Error('导航未完成');
  cdp.consoleErrors = []; cdp.exceptions = [];

  await sleep(3000); // 场景初始化（骨架/头骨 SDF 采样）
  const hasCanvas = await evalJs(cdp, `Boolean(document.querySelector('#webgl canvas'))`);
  const fps = await evalJs(cdp, `new Promise((resolve) => {
    let n = 0; const t0 = performance.now();
    const loop = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(loop); else resolve(Math.round(n * 1000 / (performance.now() - t0))); };
    requestAnimationFrame(loop);
  })`);

  const report = { meta: { pageUrl: PAGE_URL, viewport: '375x812 dpr=1', reusedTarget: Boolean(cdp.reusedTarget), startedAt: new Date().toISOString() }, fps, hasCanvas, raw: {}, checks: {} };

  /* ================= 确认项 1：P3 叠影定性 ================= */
  await scrollTo(cdp, 0.70, 3000);
  // 收敛轮询：连续两次采样一致才认为动画收敛（上限 ~12s）
  let prev = null; let cur = null; let settleRounds = 0;
  for (let i = 0; i < 8; i++) {
    cur = { p2: await phaseState(cdp, '[data-phase="p2"]'), p3: await phaseState(cdp, '[data-phase="p3"]') };
    settleRounds++;
    if (settled(prev?.p3, cur.p3) && settled(prev?.p2, cur.p2)) break;
    prev = cur; await sleep(1500);
  }

  const shotA = await capture(cdp, 'mobile-375-p3-stable');
  const sampleA = cur;
  await sleep(2000); // 任务要求 ≥2s 后再验静止稳定
  const shotB = await capture(cdp, 'mobile-375-p3-stable-plus2s');
  const sampleB = { p2: await phaseState(cdp, '[data-phase="p2"]'), p3: await phaseState(cdp, '[data-phase="p3"]') };
  const scrollYNow = await evalJs(cdp, `({ scrollY: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight, ratio: +(window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)).toFixed(4) })`);

  report.raw.t070 = { settleRounds, sampleA, sampleB, scrollYNow };
  report.raw.t070.stabilityDiffFull = diffStats(shotA.buf, shotB.buf);
  report.raw.t070.stabilityDiffBottom = diffStats(shotA.buf, shotB.buf, { x0: 0, y0: 0.70, x1: 1, y1: 1 });

  // 与既有 375 截图对照（弱参考：不同 session 星云布局可能不同）
  const oldBone = join(OUT_DIR, 'mobile-375-bone.png');
  if (existsSync(oldBone)) {
    report.raw.t070.diffVsOldBoneFull = diffStats(shotA.buf, readFileSync(oldBone));
    report.raw.t070.diffVsOldBoneBottom = diffStats(shotA.buf, readFileSync(oldBone), { x0: 0, y0: 0.70, x1: 1, y1: 1 });
  }

  // 补测 t=0.80：规范 0.78~0.84 = P3 完全可见平台期
  await scrollTo(cdp, 0.80, 3000);
  report.raw.t080 = { p2: await phaseState(cdp, '[data-phase="p2"]'), p3: await phaseState(cdp, '[data-phase="p3"]') };
  const shotC = await capture(cdp, 'mobile-375-p3-t080-plateau');
  report.raw.shotC = shotC.file;

  /* ================= 确认项 2：导航点击 ================= */
  await scrollTo(cdp, 0, 2000); // 复位到初始位置再点击（模拟用户自然操作）
  const target = await evalJs(cdp, `(() => {
    const el = document.querySelector('.nav-item');
    const r = el.getBoundingClientRect();
    return { x: +(r.x + r.width / 2).toFixed(1), y: +(r.y + r.height / 2).toFixed(1),
      label: el.querySelector('.nav-label').textContent, cursor: getComputedStyle(el).cursor,
      tag: el.tagName, insideAnchor: Boolean(el.closest('a')) };
  })()`);
  const errsBefore = [...cdp.consoleErrors, ...cdp.exceptions].length;
  await cdp.send('Runtime.evaluate', { expression: `window.__clickMarker = 'alive'; window.__urlBeforeClick = location.href; window.__domCountBefore = document.querySelectorAll('*').length;` });

  const { x, y } = target;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(900);

  const after = await evalJs(cdp, `({
    urlAfter: location.href,
    urlBefore: window.__urlBeforeClick || null,
    docMarkerAlive: window.__clickMarker === 'alive',
    domCountAfter: document.querySelectorAll('*').length,
    domCountBefore: window.__domCountBefore || null,
    activeElement: document.activeElement ? (document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).split(' ')[0] : '')) : null
  })`);
  const errsAfter = [...cdp.consoleErrors, ...cdp.exceptions];

  report.checks.navClick = {
    clickTarget: target,
    urlBefore: after.urlBefore,
    urlAfter: after.urlAfter,
    navigated: after.urlBefore !== after.urlAfter,
    documentReloaded: after.docMarkerAlive === false,
    errorCountBefore: errsBefore,
    errorCountAfter: errsAfter.length,
    newErrors: errsAfter.slice(errsBefore),
    domCountBefore: after.domCountBefore,
    domCountAfter: after.domCountAfter,
    domStructurallyIntact: after.domCountBefore === after.domCountAfter,
    activeElementAfterClick: after.activeElement
  };

  report.errorsAll = errsAfter;
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(join(process.cwd(), 'utils', 'verify', '_closeout-report.json'), JSON.stringify(report, null, 2));

  if (!cdp.reusedTarget) { try { await fetch(`${CDP_HTTP}/json/close/${cdp.targetId}`); } catch { /* ignore */ } }
  cdp.ws.close();
  process.exit(0);
})().catch((err) => { console.error('CLOSEOUT FAILED:', err); process.exit(1); });
