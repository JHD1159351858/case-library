/**
 * 临时测量（用后删除）：P1 标题 "Agent Case" 在不同字号下的渲染宽度
 * 运行：node utils/verify/_measure-title.mjs
 */
const CDP_HTTP = 'http://127.0.0.1:9222';
const PAGE_URL = 'http://127.0.0.1:1002/';

async function main() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(PAGE_URL));
  if (!page) throw new Error('no matching page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const h1 = document.querySelector('[data-phase="p1"] .title-xl');
      const cs = getComputedStyle(h1);
      const span = document.createElement('span');
      span.style.position = 'absolute';
      span.style.visibility = 'hidden';
      span.style.whiteSpace = 'nowrap';
      span.style.fontFamily = cs.fontFamily;
      span.style.fontWeight = '600';
      span.style.letterSpacing = '-0.025em';
      span.textContent = 'Agent Case';
      document.body.appendChild(span);
      const measures = {};
      for (const fs of [135, 128, 120, 112, 108, 104, 100, 96, 92, 88, 84, 80]) {
        span.style.fontSize = fs + 'px';
        measures[fs] = Math.round(span.getBoundingClientRect().width);
      }
      span.remove();
      return {
        line1WidthAt135: measures[135],
        titleRect: { w: h1.getBoundingClientRect().width, x: h1.getBoundingClientRect().x },
        colRect: h1.parentElement.getBoundingClientRect().width,
        viewport: window.innerWidth,
        fontFamily: cs.fontFamily,
        measures
      };
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(result.value, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
