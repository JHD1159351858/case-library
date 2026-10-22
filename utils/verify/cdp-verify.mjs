/**
 * CDP 浏览器验证脚本（开发工具，非交付产物）
 *
 * 用途：用 Chrome DevTools Protocol 打开本地页面，验证：
 *   1. 页面无控制台错误 / 未捕获异常
 *   2. WebGL canvas 确实渲染（CDP 截图 + PNG 像素统计非全黑）
 *   3. 六个滚动相位（0 / 0.15 / 0.35 / 0.7 / 0.88 / 0.99）截图
 *   4. 三种端宽响应式（1440 / 768 / 375）
 *   5. 导航 hover 反馈（CSS :hover -> #00ffd1）
 *   6. 降级提示 #webgl-fallback 在正常渲染时不显示
 *
 * 运行：node utils/verify/cdp-verify.mjs [pageUrl] [outDir]
 * 前置：Chrome 以 --remote-debugging-port=9222 启动；本地静态服务运行于 1002。
 *
 * 实现说明：
 *   - canvas 像素验证不采用页面内 drawImage(canvas) 采样：渲染器默认
 *     preserveDrawingBuffer=false，帧交换后绘图缓冲区即失效，会得到
 *     全黑假阴性；改为 CDP Page.captureScreenshot 截屏后经
 *     utils/verify/png.mjs 解码统计（截图是合成输出，数据源可靠）。
 *   - 目标页只复用与 pageUrl 同源的标签页；没有时新建专用标签页，
 *     避免误导航用户正在浏览的其他页面。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, analyzePixels } from './png.mjs';

const PAGE_URL = process.argv[2] || 'http://127.0.0.1:1002/';
const OUT_DIR = process.argv[3] || join(process.cwd(), 'utils', 'verify', 'shots');
const CDP_HTTP = 'http://127.0.0.1:9222';

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

      // 没有同源标签页时，新建专用标签页（而非导航用户正在浏览的页面）
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
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, max * ${progress});
      return { max, y: window.scrollY };
    })()`,
    returnByValue: true
  });
  // 等待平滑跟随（0.08 系数约 60 帧）+ 渲染稳定
  await sleep(2200);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/**
 * canvas 像素验证：CDP 截图 + PNG 解码统计（utils/verify/png.mjs）。
 *
 * 渲染器默认 preserveDrawingBuffer=false，帧交换后绘图缓冲区即失效，
 * 页面内 drawImage(canvas) 采样会得到全黑假阴性；Page.captureScreenshot
 * 拿到的是合成后的画面，是像素验证的正确数据源。统计窗口取画面中部
 * （png.mjs analyzePixels 默认窗口），避开顶部导航与底部相位文案。
 */
async function checkCanvasPixels(cdp) {
  const exists = await cdp.send('Runtime.evaluate', {
    expression: `Boolean(document.querySelector('#webgl canvas'))`,
    returnByValue: true
  });
  if (!exists.result.value) return { ok: false, reason: 'no canvas' };

  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const img = decodePng(Buffer.from(data, 'base64'));
    const stats = analyzePixels(img);
    return {
      ok: true,
      source: 'Page.captureScreenshot',
      nonBlack: stats.nonBlack,
      total: stats.sampled,
      nonBlackRatio: stats.nonBlackRatio,
      avg: stats.avgBrightness,
      size: stats.size,
      region: stats.region
    };
  } catch (err) {
    return { ok: false, reason: `screenshot stats failed: ${err.message}` };
  }
}

async function textOf(cdp, selector) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('${selector}');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { text: el.textContent.trim().slice(0, 60), opacity: cs.opacity, transform: cs.transform, color: cs.color, fontSize: cs.fontSize };
    })()`,
    returnByValue: true
  });
  return result.value;
}

/** 轮询等待表达式返回满足条件的值（per(context 重建时容错重试)） */
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
  // 禁用缓存：确保验证的是当前磁盘上的构建，而非浏览器缓存副本
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  await setViewport(cdp, 1440, 900);

  // 导航前在旧文档打标记；导航成功后新文档中该标记必须消失
  await cdp.send('Runtime.evaluate', { expression: 'window.__verifyNavMarker = true' });
  await cdp.send('Page.navigate', { url: PAGE_URL });

  const nav = await waitFor(
    cdp,
    `({ done: (typeof window.__verifyNavMarker === 'undefined') && document.readyState === 'complete', readyState: document.readyState })`,
    30000
  );
  if (!nav || !nav.done) {
    throw new Error(`导航未确认：页面可能未加载新文档（readyState=${nav?.readyState}）`);
  }
  cdp.consoleErrors = []; // 只统计新加载页面的错误
  cdp.exceptions = [];

  // 等待场景初始化完成（canvas 注入 + 非黑像素输出）
  await sleep(3000);
  let px = null;
  for (let i = 0; i < 30; i++) {
    px = await checkCanvasPixels(cdp);
    if (px.ok && px.nonBlack >= 50) break;
    await sleep(1000);
  }

  // 复用标签页时复位滚动位置，保证相位截图从初始状态开始
  await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });

  const report = {
    meta: {
      pageUrl: PAGE_URL,
      reusedTarget: Boolean(cdp.reusedTarget),
      startedAt: new Date().toISOString()
    },
    errors: [],
    checks: {}
  };

  // 1. 控制台错误
  report.errors = [...cdp.consoleErrors, ...cdp.exceptions];
  report.checks.console = report.errors.length === 0 ? 'clean' : report.errors;

  // 2. canvas 存在性与像素输出
  report.checks.canvasPixels = px;
  if (!px || !px.ok) {
    report.errors.push(`canvasPixels: sampling failed (${px?.reason || 'timeout waiting for render'})`);
    report.checks.console = report.errors;
  } else if (px.nonBlack < 50) {
    report.errors.push(
      `canvasPixels: only ${px.nonBlack}/${px.total} non-black samples (avg ${px.avg}); scene may not be rendering`
    );
    report.checks.console = report.errors;
  }

  // 2b. 降级提示在正常渲染时必须隐藏
  report.checks.fallbackHidden = (await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.getElementById('webgl-fallback');
      if (!el) return 'missing';
      return el.hidden ? 'hidden' : 'visible';
    })()`,
    returnByValue: true
  })).result.value;

  // 2b. DOM 结构确认
  report.checks.brand = await textOf(cdp, '.brand');
  report.checks.navCount = (await cdp.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.nav-item').length`,
    returnByValue: true
  })).result.value;
  report.checks.titleP1 = await textOf(cdp, '[data-phase="p1"] .title-xl');
  report.checks.titleP2 = await textOf(cdp, '[data-phase="p2"] .title-lg');

  // 3. 相位截图（PC 1440x900）
  await scrollTo(cdp, 0);
  await shot(cdp, 'pc-00-start');
  await scrollTo(cdp, 0.15);
  await shot(cdp, 'pc-15-face-zoom');
  await scrollTo(cdp, 0.35);
  await shot(cdp, 'pc-35-figure');
  await scrollTo(cdp, 0.70);
  await shot(cdp, 'pc-70-bone');
  await scrollTo(cdp, 0.88);
  await shot(cdp, 'pc-88-skull');
  await scrollTo(cdp, 0.995);
  await shot(cdp, 'pc-995-skull-close');

  // 4. P4 相位文案可见性检查（0.995 应为可见）
  report.checks.p4Visible = await textOf(cdp, '[data-phase="p4"]');

  // 5. 导航 hover（鼠标移到右上第一项）
  await scrollTo(cdp, 0);
  const navBox = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('.nav-item');
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
    returnByValue: true
  });
  const { x, y } = navBox.result.value;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(500);
  const hoverColor = await cdp.send('Runtime.evaluate', {
    expression: `getComputedStyle(document.querySelector('.nav-item .nav-label')).color`,
    returnByValue: true
  });
  report.checks.navHoverColor = hoverColor.result.value;
  await shot(cdp, 'pc-nav-hover');

  // 6. 响应式：768 平板
  await setViewport(cdp, 768, 1024);
  await sleep(1200);
  await scrollTo(cdp, 0.35);
  await shot(cdp, 'tablet-768-figure');
  report.checks.titleP2At768 = await textOf(cdp, '[data-phase="p2"] .title-lg');

  // 7. 响应式：375 手机
  await setViewport(cdp, 375, 812);
  await sleep(1200);
  await scrollTo(cdp, 0.7);
  await shot(cdp, 'mobile-375-bone');
  report.checks.brandAt375 = await textOf(cdp, '.brand');
  report.checks.navAt375 = await textOf(cdp, '.nav-item');

  // 8. 结论汇总
  report.checks.pass = report.errors.length === 0 && report.checks.fallbackHidden === 'hidden';

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

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
  console.error('VERIFY FAILED:', err);
  process.exit(1);
});
