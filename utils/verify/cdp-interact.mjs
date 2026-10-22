/**
 * CDP 交互专项验证脚本（开发工具，非交付产物）
 *
 * 验证范围（对应 doc/restore-spec.md 第 6 节「交互状态清单」中尚未被
 * cdp-verify.mjs 覆盖的项）：
 *   1. 鼠标视差：指针分别稳定在屏幕左 / 右，画面旋转状态差异显著高于环境噪声
 *   2. 鼠标扰动：指针所在状态与对侧状态的差异中同时包含粒子推开效果（并入 1 的差异度量）
 *   3. 鼠标离开回正：合成 mouseleave 后画面回到无指针稳态（差异回落至噪声量级）
 *   4. 相位 pointer-events：不可见相位为 none、可见相位为 auto（t=0 与 t=0.995 两端点）
 *   5. 窗口缩放自适应：viewport 改变后 canvas 内部分辨率跟随、场景不白屏、无错误
 *   6. 全程无控制台错误 / 未捕获异常
 *
 * 方法学：时序对称对比 + 中心窗口（抵消星云自转带来的环境噪声）
 *   - 场景星云每帧自转 +0.001rad；3s 的旋转位移已超过像素间距，全屏 diff 很快
 *     饱和（噪声在一帧间隔即达上限），且全屏均值会稀释中心对象的视差信号。
 *   - 因此所有对比采用「相隔同为 SETTLE_MS 的成对截图」，判定窗口取画面中心区
 *     （视差对象所在区域）；全屏值保留在报告中作参考。
 *       noise      = diff(base0, base1)   无鼠标稳态两帧       → 纯环境噪声
 *       contact    = diff(L0b, L0c)       指针持续静止两帧     → 噪声 + 在场扰动微动
 *       parallaxLR = diff(L0, R0)         左稳态 → 右稳态      → 噪声 + 视差旋转 + 扰动差异
 *       parallaxRL = diff(R0, L0b)        右稳态 → 回左稳态    → 双向可辨识复核
 *       recover    = diff(C1, C2)         mouseleave 回正后两帧 → 应回落至噪声量级
 *   - 断言全部基于中心区量之间的相对关系（倍数），不依赖绝对阈值。
 *     经 3~6 网格扫描标定：中心 20%×15% 窗口信噪比 ≈1.7x（全屏仅 1.16x，
 *     故不能用全屏值判定）。阈值取标定值 -20% 余量：
 *       parallaxDistinguishable: 两向视差均 > 1.35 × 噪声上界
 *       recoversToQuiet:         回正 < 1.05 × 噪声上界 且 < 0.85 × 视差均值
 *
 * 前置：Chrome 以 --remote-debugging-port=9222 启动；静态服务运行于 127.0.0.1:1002
 * 运行：node utils/verify/cdp-interact.mjs [pageUrl] [outDir]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, analyzePixels } from './png.mjs';

const PAGE_URL = process.argv[2] || 'http://127.0.0.1:1002/';
const OUT_DIR = process.argv[3] || join(process.cwd(), 'utils', 'verify', 'shots', 'interact');
const CDP_HTTP = 'http://127.0.0.1:9222';

/**
 * 状态切换后的收敛等待 / 对比帧固定间隔（两用，保证时序对称）。
 * 依据：旋转跟随 lerp 系数 0.06，3s 内帧数 ≥ 90 时残差 < 0.4%（30fps 起）。
 */
const SETTLE_MS = 3000;

/** 视差判定窗口：画面中心 20%×15%（标定见 _window-scan 结论：信噪比最优 ≈1.7x） */
const CENTER_WIN = { x0: 0.4, y0: 0.425, x1: 0.6, y1: 0.575 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 选中与目标同源的 page 标签，避免误用/创建无关标签页 */
async function getWsTarget(pageUrl) {
  const origin = new URL(pageUrl).origin;
  const expected = new URL(pageUrl);
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`);
      const list = await res.json();
      const page = list.find(
        (t) =>
          t.type === 'page' &&
          (() => {
            try {
              const u = new URL(t.url);
              return u.origin === origin || (u.hostname === expected.hostname && u.port === expected.port);
            } catch {
              return false;
            }
          })()
      );
      if (page) return { wsUrl: page.webSocketDebuggerUrl, id: page.id, reused: true };

      const created = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(pageUrl)}`, {
        method: 'PUT'
      });
      if (created.ok) {
        const tab = await created.json();
        if (tab.webSocketDebuggerUrl) return { wsUrl: tab.webSocketDebuggerUrl, id: tab.id, reused: false };
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
    this.events = [];
    this.consoleErrors = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new CDP(ws);
  cdp.reusedTarget = reused;
  cdp.targetId = id;
  return cdp;
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function scrollTo(cdp, progress) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, max * ${progress});
      return { max, y: window.scrollY };
    })()`,
    returnByValue: true
  });
  await sleep(2200); // 滚动平滑跟随（0.08 系数）+ 渲染稳定
  return result.value;
}

/** 截图并（可选）落盘，返回原始 buffer 供像素对比 */
async function capture(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  if (name) writeFileSync(join(OUT_DIR, `${name}.png`), buf);
  return buf;
}

/** 合成鼠标移动（视口坐标） */
async function mouseTo(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    pointerType: 'mouse'
  });
}

/** 在 canvas 上合成 mouseleave —— 与真实移出画布时的原生事件同一监听器 */
async function synthMouseLeave(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const canvas = document.querySelector('#webgl canvas');
      if (!canvas) return 'no-canvas';
      canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      return 'dispatched';
    })()`,
    returnByValue: true
  });
  return result.value;
}

/** 探测 1 秒内 rAF 帧率（诊断收敛质量用） */
async function probeFps(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const loop = () => {
        n++;
        if (performance.now() - t0 < 1000) requestAnimationFrame(loop);
        else resolve(Math.round((n * 1000) / (performance.now() - t0)));
      };
      requestAnimationFrame(loop);
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  return result.value;
}

/** canvas 内部分辨率信息（resize 自适应检查用） */
async function canvasInfo(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.querySelector('#webgl canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height), dpr: window.devicePixelRatio };
    })()`,
    returnByValue: true
  });
  return result.value;
}

/** 读取指定相位容器的 pointer-events（内联样式由 overlay.js 每帧写入） */
async function phasePointerEvents(cdp, selector) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('${selector}');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { style: el.style.pointerEvents, computed: cs.pointerEvents, opacity: cs.opacity };
    })()`,
    returnByValue: true
  });
  return result.value;
}

/**
 * 两帧 PNG 的逐像素差异统计（默认全图，可传相对窗口）。
 * meanAbs      = 每像素 RGB 差绝对值之和的均值（0 ~ 765）
 * changedRatio = RGB 差绝对值之和 > 24 的像素占比
 */
function diffStats(bufA, bufB, win = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
  const a = decodePng(bufA);
  const b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return { error: 'size/channels mismatch' };
  }
  const ch = a.channels;
  const w = a.width;
  const h = a.height;
  const x0 = Math.floor(w * win.x0);
  const x1 = Math.ceil(w * win.x1);
  const y0 = Math.floor(h * win.y0);
  const y1 = Math.ceil(h * win.y1);
  let sum = 0;
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * ch;
      const d =
        Math.abs(a.data[p] - b.data[p]) +
        Math.abs(a.data[p + 1] - b.data[p + 1]) +
        Math.abs(a.data[p + 2] - b.data[p + 2]);
      sum += d;
      if (d > 24) changed++;
      total++;
    }
  }
  return { meanAbs: +(sum / total).toFixed(3), changedRatio: +(changed / total).toFixed(4) };
}

/** 在 rAF 回调内采样 canvas 像素（帧交换前缓冲区有效，帧外采样为全黑假阴性） */
async function checkCanvasPixels(cdp) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      requestAnimationFrame(() => {
        const canvas = document.querySelector('#webgl canvas');
        if (!canvas) return resolve({ ok: false, reason: 'no canvas' });
        const w = 160, h = 90;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(canvas, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let nonBlack = 0, sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i] + d[i+1] + d[i+2];
          sum += v;
          if (v > 24) nonBlack++;
        }
        resolve({ ok: true, nonBlack, total: d.length / 4, avg: Math.round((sum / (d.length / 4)) * 100) / 100 });
      });
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  if (exceptionDetails) return { ok: false, reason: 'evaluate failed' };
  return result.value;
}

/** 轮询等待表达式返回满足条件的值 */
async function waitFor(cdp, expression, timeoutMs = 20000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      last = result.value;
      if (last && last.done) return last;
    } catch {
      /* 导航过程中执行上下文可能暂不可用，继续重试 */
    }
    await sleep(intervalMs);
  }
  return last;
}

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const cdp = await connect(PAGE_URL);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await setViewport(cdp, 1440, 900);

  // 导航前打标记；导航成功后新文档中标记必须消失
  await cdp.send('Runtime.evaluate', { expression: 'window.__interactNavMarker = true' });
  await cdp.send('Page.navigate', { url: PAGE_URL });
  const nav = await waitFor(
    cdp,
    `({ done: (typeof window.__interactNavMarker === 'undefined') && document.readyState === 'complete', readyState: document.readyState })`,
    30000
  );
  if (!nav || !nav.done) throw new Error(`导航未确认：页面可能未加载新文档（readyState=${nav?.readyState}）`);
  cdp.consoleErrors = [];
  cdp.exceptions = [];

  // 等待场景初始化完成（canvas 注入 + 非黑像素输出）
  await sleep(2500);
  let px = null;
  for (let i = 0; i < 30; i++) {
    px = await checkCanvasPixels(cdp);
    if (px.ok && px.nonBlack >= 50) break;
    await sleep(1000);
  }

  const report = {
    meta: {
      pageUrl: PAGE_URL,
      reusedTarget: Boolean(cdp.reusedTarget),
      startedAt: new Date().toISOString(),
      settleMs: SETTLE_MS
    },
    errors: [],
    timing: {},
    raw: {},
    checks: {}
  };

  report.raw.initialCanvasPixels = px;
  report.timing.fps = await probeFps(cdp);
  if (report.timing.fps < 15) {
    report.timing.warning = `rAF fps=${report.timing.fps}，低于 15，收敛等待可能不足`;
  }

  // ---------- 0. 初始状态（t=0）：相位 pointer-events 基线 ----------
  await scrollTo(cdp, 0);
  await sleep(SETTLE_MS);
  report.checks.peAt0 = {
    p1: await phasePointerEvents(cdp, '[data-phase="p1"]'),
    p2: await phasePointerEvents(cdp, '[data-phase="p2"]'),
    p3: await phasePointerEvents(cdp, '[data-phase="p3"]'),
    p4: await phasePointerEvents(cdp, '[data-phase="p4"]')
  };
  report.raw.canvasAtStart = await canvasInfo(cdp);

  // ---------- 1. 环境噪声基线（无鼠标，间隔 SETTLE_MS 两帧） ----------
  const base0 = await capture(cdp, 'base0');
  await sleep(SETTLE_MS);
  const base1 = await capture(cdp, 'base1');
  report.raw.noise = diffStats(base0, base1);
  report.raw.noiseCenter = diffStats(base0, base1, CENTER_WIN);

  // ---------- 2. 视差：左稳态 → 右稳态 → 回左稳态（三帧对称间隔） ----------
  await mouseTo(cdp, 250, 450); // NDC x ≈ -0.65
  await sleep(SETTLE_MS);
  const L0 = await capture(cdp, 'left0'); // 左稳态第一帧（视差基准）
  await sleep(SETTLE_MS);
  const L0b = await capture(cdp, 'left1'); // 左稳态复核帧 / 双向视差回程终点
  await sleep(SETTLE_MS);
  const L0c = await capture(cdp, 'left2');
  report.raw.contact = diffStats(L0b, L0c); // 指针静止两帧：噪声 + 在场扰动微动
  report.raw.contactCenter = diffStats(L0b, L0c, CENTER_WIN);

  await mouseTo(cdp, 1190, 450); // NDC x ≈ +0.65
  await sleep(SETTLE_MS);
  const R0 = await capture(cdp, 'right0');
  await sleep(SETTLE_MS);
  const R1 = await capture(cdp, 'right1');
  report.raw.parallax = diffStats(L0, R0);
  report.raw.parallaxCenter = diffStats(L0, R0, CENTER_WIN);
  report.raw.parallaxBack = diffStats(R0, L0b); // 回程：右稳态 → 左稳态
  report.raw.parallaxBackCenter = diffStats(R0, L0b, CENTER_WIN);
  report.raw.rightContactCenter = diffStats(R0, R1, CENTER_WIN); // 右侧静止对照

  // ---------- 3. 鼠标离开回正 ----------
  report.raw.mouseLeaveDispatch = await synthMouseLeave(cdp);
  await sleep(SETTLE_MS);
  const C1 = await capture(cdp, 'recenter1');
  await sleep(SETTLE_MS);
  const C2 = await capture(cdp, 'recenter2');
  report.raw.recover = diffStats(C1, C2);
  report.raw.recoverCenter = diffStats(C1, C2, CENTER_WIN);
  report.raw.recenterAfterLeft = diffStats(L0, C1); // 左稳态 → 回正（语义：旋转回归量）

  // ---------- 4. 相对关系断言（中心窗口；阈值基于信噪比标定：视差/噪声 ≈1.7x） ----------
  const eps = 0.01;
  const cMean = (k) => Math.max(eps, report.raw[k]?.meanAbs || eps);
  // 噪声上界：任一同状态静止对的最大帧间差异（保守口径，通过标准更严）
  const noiseUpper = Math.max(cMean('noiseCenter'), cMean('contactCenter'), cMean('rightContactCenter'));
  const parallaxLR = cMean('parallaxCenter');
  const parallaxRL = cMean('parallaxBackCenter');
  const parallaxMean = (parallaxLR + parallaxRL) / 2;
  const recoverMean = cMean('recoverCenter');
  report.checks.ratios = {
    parallaxLRVsNoise: +(parallaxLR / noiseUpper).toFixed(2),
    parallaxRLVsNoise: +(parallaxRL / noiseUpper).toFixed(2),
    parallaxMeanVsNoise: +(parallaxMean / noiseUpper).toFixed(2),
    recoverVsNoise: +(recoverMean / noiseUpper).toFixed(2),
    recoverVsParallax: +(recoverMean / parallaxMean).toFixed(2)
  };
  report.checks.assertions = {
    parallaxDistinguishable: parallaxLR > noiseUpper * 1.35 && parallaxRL > noiseUpper * 1.35,
    recoversToQuiet: recoverMean < noiseUpper * 1.05 && recoverMean < parallaxMean * 0.85
  };

  // ---------- 5. 相位 pointer-events：滚动至结尾（P4 可见 / P1 隐藏） ----------
  await scrollTo(cdp, 0.995);
  await sleep(SETTLE_MS);
  report.checks.peAtEnd = {
    p1: await phasePointerEvents(cdp, '[data-phase="p1"]'),
    p2: await phasePointerEvents(cdp, '[data-phase="p2"]'),
    p3: await phasePointerEvents(cdp, '[data-phase="p3"]'),
    p4: await phasePointerEvents(cdp, '[data-phase="p4"]')
  };
  report.checks.assertions.pointerEventsAt0 =
    report.checks.peAt0.p1?.style === 'auto' &&
    report.checks.peAt0.p2?.style === 'none' &&
    report.checks.peAt0.p3?.style === 'none' &&
    report.checks.peAt0.p4?.style === 'none';
  report.checks.assertions.pointerEventsAtEnd =
    report.checks.peAtEnd.p1?.style === 'none' &&
    report.checks.peAtEnd.p4?.style === 'auto';

  // ---------- 6. 窗口缩放自适应 ----------
  await setViewport(cdp, 1024, 768);
  await sleep(1500);
  const ci = await canvasInfo(cdp);
  report.raw.canvasAfterResize = ci;
  // 视口尺寸以文档可用宽高为准：滚动条会占用宽度，直接比对 1024 是假阴性来源
  const vp = await cdp.send('Runtime.evaluate', {
    expression: `({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight, dpr: window.devicePixelRatio })`,
    returnByValue: true
  });
  const vpSize = vp.result.value;
  report.raw.viewportAfterResize = vpSize;
  const rz = await capture(cdp, 'resize-1024x768');
  report.raw.resizeFrame = analyzePixels(decodePng(rz));
  const expectedW = Math.round(vpSize.w * vpSize.dpr);
  const expectedH = Math.round(vpSize.h * vpSize.dpr);
  report.checks.assertions.resizeFollows =
    !!ci &&
    Math.abs(ci.w - expectedW) <= 2 &&
    Math.abs(ci.h - expectedH) <= 2 &&
    report.raw.resizeFrame.nonBlackRatio > 0.005;
  // 复原视口
  await setViewport(cdp, 1440, 900);

  // ---------- 7. 控制台错误汇总 ----------
  report.errors = [...cdp.consoleErrors, ...cdp.exceptions];
  report.checks.console = report.errors.length === 0 ? 'clean' : report.errors;

  // ---------- 8. 结论 ----------
  const a = report.checks.assertions;
  report.checks.pass =
    report.errors.length === 0 &&
    Boolean(px && px.ok && px.nonBlack >= 50) &&
    a.parallaxDistinguishable &&
    a.recoversToQuiet &&
    a.pointerEventsAt0 &&
    a.pointerEventsAtEnd &&
    a.resizeFollows;

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'report-interact.json'), JSON.stringify(report, null, 2));

  // 只清理本脚本新建的标签页；复用用户标签页时保持原状
  if (!cdp.reusedTarget) {
    try {
      await fetch(`${CDP_HTTP}/json/close/${cdp.targetId}`);
    } catch {
      /* ignore */
    }
  }
  cdp.ws.close();
  process.exit(report.checks.pass ? 0 : 1);
})().catch((err) => {
  console.error('INTERACT VERIFY FAILED:', err);
  process.exit(1);
});
