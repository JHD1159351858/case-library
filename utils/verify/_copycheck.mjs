/**
 * 临时验证脚本（验证后删除）：文案替换与布局检查
 * 用途：确认 Human Synthesis -> Agent Case Library、The World -> ChaoXing LiaoNing
 *       渲染正确、未见换行/重叠等布局问题。
 * 运行：node utils/verify/_copycheck.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_URL = 'http://127.0.0.1:1002/';
const OUT_DIR = join(process.cwd(), 'utils', 'verify', 'shots', 'copycheck');
const CDP_HTTP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsTarget(pageUrl) {
  const origin = new URL(pageUrl).origin;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${CDP_HTTP}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && (() => { try { return new URL(t.url).origin === origin; } catch { return false; } })());
      if (page) return page.webSocketDebuggerUrl;
      const created = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });
      if (created.ok) { const tab = await created.json(); if (tab.webSocketDebuggerUrl) return tab.webSocketDebuggerUrl; }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('CDP unavailable');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
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

async function connect() {
  const wsUrl = await getWsTarget(PAGE_URL);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return new CDP(ws);
}

async function inspect(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const brand = document.querySelector('.brand');
      const title = document.querySelector('[data-phase="p1"] .title-xl');
      const nav = document.querySelector('.main-nav');
      if (!brand || !title || !nav) return { missing: true };
      const br = brand.getBoundingClientRect();
      const tr = title.getBoundingClientRect();
      const nr = nav.getBoundingClientRect();
      const brandSel = getComputedStyle(brand);
      return {
        docTitle: document.title,
        brandText: brand.textContent.trim(),
        titleText: title.textContent.trim(),
        brandRect: { x: br.x, y: br.y, w: br.width, h: br.height, right: br.right, bottom: br.bottom },
        navRect: { x: nr.x, y: nr.y, w: nr.width, h: nr.height },
        titleRect: { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
        brandLineHeight: brandSel.lineHeight,
        brandOverflowWrap: brand.scrollWidth > brand.clientWidth,
        gapBrandToNav: nr.x - br.right,
        titleLines: Math.round(tr.height / parseFloat(brandSel.lineHeight || 30)),
        viewport: { w: window.innerWidth, h: window.innerHeight }
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

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const cdp = await connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(3500);

  const report = { desktop: null, mobile: null, shots: [], errors: [] };

  // 桌面 1440x900
  await setViewport(cdp, 1440, 900);
  await sleep(1000);
  report.desktop = await inspect(cdp);
  report.shots.push(await shot(cdp, 'desktop-1440-start'));

  // 移动 375x812
  await setViewport(cdp, 375, 812);
  await sleep(1000);
  report.mobile = await inspect(cdp);
  report.shots.push(await shot(cdp, 'mobile-375-start'));

  report.errors = cdp.errors;
  writeFileSync(join(OUT_DIR, 'copycheck.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
