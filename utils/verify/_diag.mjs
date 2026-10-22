/**
 * 临时诊断：为什么 P1 样式未生效（验证后删除）
 */
const CDP_HTTP = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:1002/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsTarget() {
  const origin = new URL(PAGE_URL).origin;
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
  const wsUrl = await getWsTarget();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');

  // 重新加载（无缓存）后再测
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: PAGE_URL + '?t=' + Date.now() });
  await sleep(2500);

  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = {};
      out.supportCqw = CSS.supports('font-size', '17.2cqw');
      out.supportContainer = CSS.supports('container-type', 'inline-size');
      out.supportClamp = CSS.supports('font-size', 'clamp(44px, 17.2cqw, 52px)');
      const col = document.querySelector('.phase-p1 .phase-title-col');
      out.colFound = !!col;
      if (col) {
        const cs = getComputedStyle(col);
        out.colMaxWidth = cs.maxWidth;
        out.colContainerType = cs.containerType;
        out.colWidth = Math.round(col.getBoundingClientRect().width);
      }
      const h1 = document.querySelector('.phase-p1 .title-xl');
      if (h1) {
        const cs2 = getComputedStyle(h1);
        out.h1FontSize = cs2.fontSize;
        out.h1LineHeight = cs2.lineHeight;
      }
      // 检查样式表里是否有该规则
      let found = [];
      for (const ss of document.styleSheets) {
        try {
          for (const r of ss.cssRules) {
            if (r.cssText && r.cssText.includes('phase-p1')) found.push(r.cssText.slice(0, 160));
          }
        } catch (e) { found.push('ERR: ' + e.message); }
      }
      out.rules = found;
      // 资源加载方式
      const res = performance.getEntriesByType('resource').filter(r => r.name.includes('styles.css'));
      out.cssEntries = res.map(r => ({ name: r.name, size: r.transferSize, dur: Math.round(r.duration) }));
      return out;
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(result.value, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
