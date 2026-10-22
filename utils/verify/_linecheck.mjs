/**
 * 临时验证脚本（验证后删除）：标题行数与 404 资源排查
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
    this.ws = ws; this.id = 0; this.pending = new Map(); this.network = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (r.status >= 400) this.network.push({ url: r.url, status: r.status });
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
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE_URL + '?t=' + Date.now() });
  await sleep(4000);

  // 用 Range 逐行测量标题实际渲染的行文本
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const h1 = document.querySelector('[data-phase="p1"] .title-xl');
      if (!h1) return { error: 'no h1' };
      const node = h1.firstChild;
      const text = node.textContent;
      const range = document.createRange();
      const lines = [];
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
            lineStart = i;
            lastTop = rect.top;
          }
        }
      }
      lines.push(text.slice(lineStart));
      const cs = getComputedStyle(h1);
      return { fullText: JSON.stringify(text), lines, fontSize: cs.fontSize, lineHeight: cs.lineHeight, width: h1.getBoundingClientRect().width };
    })()`,
    returnByValue: true
  });
  console.log('TITLE_LINES:', JSON.stringify(result.value, null, 2));
  console.log('NETWORK_4xx:', JSON.stringify(cdp.network, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
