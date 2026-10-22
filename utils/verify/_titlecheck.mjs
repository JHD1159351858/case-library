/**
 * 临时验证脚本：P1 标题 "Agent Case / Library" 多视口行数与尺寸检查
 * 运行：node utils/verify/_titlecheck.mjs <前缀> [--shot]
 * 例：  node utils/verify/_titlecheck.mjs before --shot
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = process.argv[2] || 'check';
const WANT_SHOT = process.argv.includes('--shot');
const CDP_HTTP = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:1002/';
const OUT_DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'titlecheck');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { w: 1440, h: 900, name: 'desktop-1440' },
  { w: 1280, h: 800, name: 'desktop-1280' },
  { w: 1024, h: 768, name: 'tablet-1024' },
  { w: 768, h: 1024, name: 'tablet-768' },
  { w: 640, h: 900, name: 'phablet-640' },
  { w: 375, h: 812, name: 'mobile-375' },
];

async function getWsTarget(pageUrl) {
  const origin = new URL(pageUrl).origin;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && (() => { try { return new URL(t.url).origin === origin; } catch { return false; } })());
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('CDP unavailable');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
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

async function inspect(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const h1 = document.querySelector('[data-phase="p1"] .title-xl');
      if (!h1) return { error: 'no h1' };
      const node = h1.firstChild;
      const text = node.textContent;
      const range = document.createRange();
      const lines = [];
      const lineTops = [];
      let lineStart = 0;
      let lastTop = null;
      for (let i = 0; i <= text.length; i++) {
        if (i < text.length) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (lastTop === null) lastTop = rect.top;
          else if (Math.abs(rect.top - lastTop) > 5) {
            lines.push(text.slice(lineStart, i));
            lineTops.push(lastTop);
            lineStart = i;
            lastTop = rect.top;
          }
        }
      }
      lines.push(text.slice(lineStart));
      const cs = getComputedStyle(h1);
      const hr = h1.getBoundingClientRect();
      const col = h1.parentElement.getBoundingClientRect();
      return {
        lines,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        titleWidth: Math.round(hr.width),
        titleHeight: Math.round(hr.height),
        titleBottom: Math.round(hr.bottom),
        colWidth: Math.round(col.width),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        overflowFree: document.documentElement.scrollWidth <= window.innerWidth
      };
    })()`,
    returnByValue: true
  });
  return result.value;
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const wsUrl = await getWsTarget(PAGE_URL);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE_URL + '?t=' + Date.now() });
  await sleep(4000);

  const report = {};
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    report[vp.name] = await inspect(cdp);
    if (WANT_SHOT && (vp.name === 'desktop-1440' || vp.name === 'mobile-375' || vp.name === 'tablet-768')) {
      await shot(cdp, `${PREFIX}-${vp.name}`);
    }
  }
  writeFileSync(join(OUT_DIR, `${PREFIX}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
