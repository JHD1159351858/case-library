/**
 * 临时验证脚本（验证后删除）：精确测量标题各行宽度
 */
const CDP_HTTP = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:1002/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const wsUrl = await getWsTarget(PAGE_URL);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  const widths = [
    { w: 1440, h: 900 },
    { w: 1280, h: 800 },
    { w: 1024, h: 768 },
    { w: 768, h: 900 },
    { w: 640, h: 900 },
    { w: 375, h: 812 }
  ];

  for (const vp of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const h1 = document.querySelector('[data-phase="p1"] .title-xl');
        const col = h1.closest('.phase-title-col');
        const cs = getComputedStyle(h1);
        // 用 canvas 精确测量文本宽度
        const cvs = document.createElement('canvas');
        const ctx = cvs.getContext('2d');
        ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' / ' + cs.lineHeight + ' ' + cs.fontFamily;
        const measure = (s) => Math.round(ctx.measureText(s).width);
        return {
          vp: [${vp.w}, ${vp.h}],
          fontSize: cs.fontSize,
          colWidth: Math.round(col.getBoundingClientRect().width),
          h1Width: Math.round(h1.getBoundingClientRect().width),
          h1Height: Math.round(h1.getBoundingClientRect().height),
          renderLines: Math.round(h1.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
          mAgent: measure('Agent'),
          mAgentCase: measure('Agent Case'),
          mLibrary: measure('Library'),
          mTheWorld: measure('ChaoXing LiaoNing')
        };
      })()`,
      returnByValue: true
    });
    console.log(JSON.stringify(result.value));
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
