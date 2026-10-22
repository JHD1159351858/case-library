/**
 * 智能体前台四项修复的 CDP 浏览器验证脚本（开发工具，非交付产物）
 *
 * 覆盖（对应本轮修复的 4 个问题）：
 *   1. 图片上传：真实浏览器选择 PNG → 上传成功、预览回显、字段写入；
 *      非法内容（HTML 伪装 .png）与不支持的格式均给出中文失败提示
 *   2. 字段展示：管理端填写全部字段提交 → 查询平台卡片 / 详情弹窗完整展示
 *   3. 弹窗样式：字号层级（标题 > 正文 > 辅助）、配色不含紫色、hover 与过渡反馈、
 *      PC / 平板 / 手机三档自适应且无横向溢出
 *   4. 智能体链接：卡片与弹窗均渲染可点击链接（target=_blank + rel=noopener noreferrer），
 *      点击后新标签真实打开目标地址
 *
 * 安全说明：脚本为了验证「已登录管理员」链路，会向数据库写入一个临时会话
 * （cookie 值随机生成，仅验证进程与本次浏览器知晓），并在结束时清理本次新增的
 * 会话 / 记录 / 上传文件。
 *
 * 运行：node utils/verify/cdp-agent-fix.mjs [baseUrl]
 * 前置：后端已启动（node .preview-server.js）；Chrome 以 --remote-debugging-port=9222 启动
 * 产物：utils/verify/shots/agent-fix/（截图 + report.json + 运行期上传的测试素材）
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

const BASE = process.argv[2] || 'http://127.0.0.1:2001';
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const OUT_DIR = process.env.VERIFY_OUT_DIR || join(process.cwd(), 'utils', 'verify', 'shots', 'agent-fix');
const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'database', 'agent-website.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || join(process.cwd(), 'database', 'uploads');
const SESSION_COOKIE = 'agent_site_session';
const TEST_UID = 'crow5_verify_admin';

/** 1×1 透明 PNG（真实图片字节） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/* ---------------- 测试用 PNG 生成（零依赖：zlib + 手写 CRC32） ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 生成一张带渐变与色块的 RGB PNG（作为「案例封面」测试素材） */
function makeCoverPng(width = 640, height = 280) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = x / width;
      const glow = Math.max(0, 1 - Math.hypot((x - width * 0.28) / (width * 0.5), (y - height * 0.5) / (height * 0.9)));
      raw[offset++] = Math.round(6 + 4 * t);
      raw[offset++] = Math.round(30 + 150 * t * glow + 26 * (1 - t));
      raw[offset++] = Math.round(60 + 150 * glow + 40 * (1 - t));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);
const now = () => Date.now();

/* ============================ 数据库准备 / 清理 ============================ */

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 4000;');

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const preexistingUser = db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(TEST_UID);
let testUserId = preexistingUser?.id ?? null;
let sessionInserted = false;
const runId = now();
const agentName = `Crow5四修复验证-${runId}`;
const createdAgentIds = [];
let uploadsBefore = new Set();

function seedSession() {
  const ts = now();
  if (!testUserId) {
    db.prepare(
      `INSERT INTO users (sso_uid, name, display_name, role, roles_json, openid, fid, org_name, is_admin, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, 'admin', '["admin"]', '', '', 'Crow5 验证', 1, ?, ?, ?)`
    ).run(TEST_UID, TEST_UID, 'Crow5 验证管理员', ts, ts, ts);
    testUserId = db.prepare('SELECT id FROM users WHERE sso_uid = ?').get(TEST_UID).id;
  }
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    testUserId,
    ts + 60 * 60 * 1000,
    ts
  );
  sessionInserted = true;
}

/** 通过接口删除本次创建的记录（顺带触发封面回收），再清理会话与残留文件 */
async function cleanup() {
  const removed = { agents: 0, sessions: 0, user: 0, uploads: 0 };
  for (const id of createdAgentIds) {
    try {
      const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { cookie: `${SESSION_COOKIE}=${token}` }
      });
      if (res.ok) removed.agents += 1;
    } catch {
      /* 忽略：下面还有兜底清理 */
    }
  }
  try {
    db.prepare('DELETE FROM agents WHERE name = ?').run(agentName);
    if (sessionInserted) removed.sessions = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes;
    if (!preexistingUser && testUserId) removed.user = db.prepare('DELETE FROM users WHERE id = ?').run(testUserId).changes;
  } catch (err) {
    console.error('[cleanup] 清理异常:', err.message);
  }
  db.close();

  if (existsSync(UPLOADS_DIR)) {
    for (const name of readdirSync(UPLOADS_DIR)) {
      if (uploadsBefore.has(name)) continue;
      try {
        rmSync(join(UPLOADS_DIR, name), { force: true });
        removed.uploads += 1;
      } catch {
        /* 忽略 */
      }
    }
  }
  return removed;
}

/* ================================ CDP 封装 ================================ */

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
      for (const t of list) {
        if (t.type !== 'page') continue;
        try {
          if (new URL(t.url).origin !== BASE) continue;
        } catch {
          continue;
        }
        return { wsUrl: t.webSocketDebuggerUrl, targetId: t.id };
      }
      const created = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(`${BASE}/agents.html`)}`, { method: 'PUT' });
      if (created.ok) {
        const tab = await created.json();
        if (tab.webSocketDebuggerUrl) return { wsUrl: tab.webSocketDebuggerUrl, targetId: tab.id };
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
    this.consoleErrors = [];
    this.exceptions = [];
    this.allExceptions = [];
    this.requests = new Map();
    this.responseReads = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.exception?.description || d.text);
        this.allExceptions.push(d.exception?.description || d.text);
      } else if (msg.method === 'Network.requestWillBeSent' && /\/api\/(agents|uploads)(?:\/|\?|$)/.test(msg.params.request.url)) {
        const request = msg.params.request;
        this.requests.set(msg.params.requestId, {
          url: request.url, method: request.method,
          contentType: request.headers['Content-Type'] || request.headers['content-type'] || '',
          ...(request.postData && /application\/json/.test(request.headers['Content-Type'] || request.headers['content-type'] || '')
            ? { payload: request.postData } : {})
        });
      } else if (msg.method === 'Network.responseReceived' && this.requests.has(msg.params.requestId)) {
        const response = msg.params.response;
        Object.assign(this.requests.get(msg.params.requestId), { status: response.status, mimeType: response.mimeType });
      } else if (msg.method === 'Network.loadingFinished' && this.requests.has(msg.params.requestId)) {
        const entry = this.requests.get(msg.params.requestId);
        this.responseReads.push(this.send('Network.getResponseBody', { requestId: msg.params.requestId }).then(({ body }) => {
          entry.response = body;
        }).catch(() => {}));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const entry = msg.params.entry;
        const text = `[${entry.source}] ${entry.text}`;
        if (!/favicon\.ico/i.test(text)) this.consoleErrors.push(text);
      }
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  resetErrors() {
    this.consoleErrors = [];
    this.exceptions = [];
  }

  errors() {
    return [...this.consoleErrors, ...this.exceptions];
  }
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (exceptionDetails) throw new Error(`页面执行异常: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
  return result.value;
}

async function waitFor(cdp, expression, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, expression);
      if (last && last.done) return last;
    } catch {
      /* 导航中上下文可能重建，继续重试 */
    }
    await sleep(intervalMs);
  }
  return last ?? { done: false };
}

async function navigate(cdp, url, expectPath) {
  cdp.resetErrors();
  await evaluate(cdp, 'window.__verifyNavMarker = 1').catch(() => {});
  await cdp.send('Page.navigate', { url });
  const nav = await waitFor(
    cdp,
    `({ done: typeof window.__verifyNavMarker === 'undefined' && document.readyState === 'complete' && location.pathname === ${JSON.stringify(expectPath)}, path: location.pathname })`,
    30000
  );
  if (!nav.done) throw new Error(`导航未完成：${url}（当前路径 ${nav.path ?? '未知'}）`);
  await sleep(700);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function setCookie(cdp, value) {
  await cdp.send('Network.setCookie', {
    name: SESSION_COOKIE,
    value,
    url: `${BASE}/`,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax'
  });
}

/** 真实鼠标点击（带用户手势，避免 target=_blank 被弹窗拦截误判为失败） */
async function clickAt(cdp, x, y) {
  const point = { x: Math.round(x), y: Math.round(y) };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(70);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1, buttons: 0 });
}

/** 把本地文件塞进 <input type=file>（等价于用户在文件选择器里选中该文件） */
async function setFileInput(cdp, selector, files) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`未找到文件输入框：${selector}`);
  await cdp.send('DOM.setFileInputFiles', { files, nodeId });
}

/* ================================ 断言工具 ================================ */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  → ${typeof detail === 'object' ? JSON.stringify(detail) : detail}` : ''}`);
}

/** 步骤日志（定位脚本卡在哪一步；断言结果由 check 输出） */
function step(text) {
  console.log(`[step] ${text}`);
}

/** 解析 rgb()/rgba() 字符串 → { r, g, b } */
const parseRgb = (value) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(value));
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
};

/* ================================= 主流程 ================================= */

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(UPLOADS_DIR, { recursive: true });
  uploadsBefore = new Set(readdirSync(UPLOADS_DIR));

  // 运行期测试素材（放在 gitignore 的 shots 目录内）
  const coverPng = makeCoverPng();
  const fixtureOk = join(OUT_DIR, 'cover-ok.png');
  const fixtureFake = join(OUT_DIR, 'cover-fake.png');
  const fixtureBadType = join(OUT_DIR, 'cover-bad.bmp');
  writeFileSync(fixtureOk, coverPng);
  writeFileSync(fixtureFake, Buffer.from('<html><body><script>alert(1)</script>不是图片</body></html>'));
  writeFileSync(fixtureBadType, Buffer.from('BM0000000000000000000000000000'));

  const { wsUrl } = await getTarget();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  seedSession();
  await setCookie(cdp, token);

  /* ------------------ 1. 管理端：图片上传（成功 / 失败提示） ------------------ */
  step('打开管理端');
  await navigate(cdp, `${BASE}/admin.html`, '/admin.html');
  await waitFor(cdp, `({ done: document.getElementById('admin-content') && !document.getElementById('admin-content').hidden })`, 15000);
  await sleep(800);

  const uploadOk = await (async () => {
    cdp.resetErrors();
    step('选择合法 PNG 上传');
    await setFileInput(cdp, '#cover-file', [fixtureOk]);
    const state = await waitFor(
      cdp,
      `(() => {
        const status = document.getElementById('cover-status');
        const field = document.getElementById('field-cover');
        const img = document.querySelector('#cover-preview img');
        const notice = document.getElementById('create-notice');
        return {
          done: status && status.textContent === '已上传',
          status: status?.textContent ?? '',
          fieldValue: field?.value ?? '',
          imgSrc: img?.getAttribute('src') ?? '',
          imgLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
          noticeText: notice?.textContent ?? '',
          noticeTone: notice?.dataset.tone ?? ''
        };
      })()`,
      15000
    );
    return state;
  })();

  check('上传成功：状态显示「已上传」', uploadOk.status === '已上传', uploadOk.status);
  check('上传成功：/uploads/ 站内地址写入表单字段', /^\/uploads\/\d+_[0-9a-f]{8}\.png$/.test(uploadOk.fieldValue), uploadOk.fieldValue);
  check('上传成功：预览图真实渲染（naturalWidth > 0）', uploadOk.imgLoaded === true, uploadOk.imgSrc);
  check('上传成功：给出成功提示', uploadOk.noticeTone === 'success' && /封面已上传/.test(uploadOk.noticeText), uploadOk.noticeText);

  const uploadFetched = await (async () => {
    const response = await fetch(`${BASE}${uploadOk.fieldValue}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, type: response.headers.get('content-type'), same: bytes.equals(coverPng) };
  })();
  check(
    '上传成功：前台可原样取回图片',
    uploadFetched.status === 200 && uploadFetched.type === 'image/png' && uploadFetched.same,
    uploadFetched
  );
  await shot(cdp, '01-admin-upload-ok');

  // 失败：HTML 伪装成 .png（客户端类型校验通过，服务端按内容拒绝）
  step('上传非图片内容（应失败）');
  await setFileInput(cdp, '#cover-file', [fixtureFake]);
  const fakeFail = await waitFor(
    cdp,
    `(() => {
      const notice = document.getElementById('create-notice');
      const status = document.getElementById('cover-status');
      return { done: notice?.dataset.tone === 'error' && notice.textContent.length > 0, tone: notice?.dataset.tone ?? '', text: notice?.textContent ?? '', status: status?.textContent ?? '' };
    })()`,
    15000
  );
  check(
    '上传失败：非图片内容给出中文提示',
    fakeFail.tone === 'error' && /不是有效图片/.test(fakeFail.text) && fakeFail.status === '上传失败',
    fakeFail.text
  );

  // 失败：不支持的格式（客户端前置拦截）
  step('上传不支持的格式（应失败）');
  await setFileInput(cdp, '#cover-file', [fixtureBadType]);
  const typeFail = await waitFor(
    cdp,
    `(() => {
      const notice = document.getElementById('create-notice');
      return { done: notice?.dataset.tone === 'error' && /不支持的图片格式/.test(notice.textContent), text: notice?.textContent ?? '' };
    })()`,
    8000
  );
  check('上传失败：不支持的格式给出中文提示', typeFail.done === true, typeFail.text);
  await shot(cdp, '02-admin-upload-fail');

  step('验证 GIF / WebP 上传与浏览器解码');
  const imageBoundary = '----crow5-image-boundary';
  const gifBase = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const comment = Buffer.from(`marker--${imageBoundary}inside\r\n--${imageBoundary}inside\r\n--${imageBoundary}--inside`);
  const gif = Buffer.concat([gifBase.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b])]);
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  for (const [mime, bytes] of [['image/gif', gif], ['image/webp', webp]]) {
    const image = await evaluate(cdp, `(async () => {
      const bytes = new Uint8Array(${JSON.stringify([...bytes])});
      const boundary = ${JSON.stringify(imageBoundary)};
      const body = new Blob([
        '--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="cover"\\r\\nContent-Type: ${mime}\\r\\n\\r\\n',
        bytes, '\\r\\n--' + boundary + '--\\r\\n'
      ]);
      const response = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, body });
      const data = await response.json();
      if (!response.ok) return { status: response.status, error: data.error };
      const saved = await fetch(data.url);
      const retrieved = new Uint8Array(await saved.arrayBuffer());
      const field = document.getElementById('field-cover');
      field.value = data.url;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const image = document.querySelector('#cover-preview img');
      await image.decode();
      return { status: response.status, type: saved.headers.get('content-type'), same: bytes.length === retrieved.length && bytes.every((value, i) => value === retrieved[i]), width: image.naturalWidth };
    })()`);
    check(`${mime} 上传回显：字节完整、类型正确且浏览器可解码`, image.status === 201 && image.type === mime && image.same && image.width > 0, image);
  }

  step('验证上传中的提交阻断与清除后迟到响应');
  await evaluate(cdp, `(() => {
    window.__verifyOriginalFetch = window.fetch;
    window.__verifyWrites = 0;
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (url === '/api/agents' && args[1]?.method === 'POST') window.__verifyWrites++;
      const response = await window.__verifyOriginalFetch(...args);
      if (url === '/api/uploads') {
        await new Promise(resolve => { window.__verifyReleaseUpload = resolve; });
        window.__verifyUploadReleased = true;
      }
      return response;
    };
    document.getElementById('cover-clear').click();
    document.getElementById('field-name').value = ${JSON.stringify(agentName)};
  })()`);
  await setFileInput(cdp, '#cover-file', [fixtureOk]);
  await waitFor(cdp, `({ done: Boolean(window.__verifyReleaseUpload) })`);
  const pendingUpload = await evaluate(cdp, `(() => {
    const disabled = document.getElementById('form-submit').disabled;
    document.getElementById('agent-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return { disabled, writes: window.__verifyWrites, status: document.getElementById('cover-status').textContent };
  })()`);
  check('上传未完成：禁用提交且程序提交不会保存缺封面的记录', pendingUpload.disabled && pendingUpload.writes === 0, pendingUpload);
  await evaluate(cdp, `document.getElementById('cover-clear').click(); window.__verifyReleaseUpload();`);
  await waitFor(cdp, `({ done: Boolean(window.__verifyUploadReleased) })`);
  await sleep(100);
  const staleUpload = await evaluate(cdp, `(() => {
    window.fetch = window.__verifyOriginalFetch;
    return { field: document.getElementById('field-cover').value, hasImage: Boolean(document.querySelector('#cover-preview img')), disabled: document.getElementById('form-submit').disabled };
  })()`);
  check('清除封面：迟到上传不会回填旧图片，提交恢复可用', staleUpload.field === '' && !staleUpload.hasImage && !staleUpload.disabled, staleUpload);

  const invalidLink = await evaluate(cdp, `(async () => {
    const response = await fetch('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(agentName)}, agentUrl: 'https://' }) });
    return { status: response.status, body: await response.json() };
  })()`);
  check('链接校验：不可解析的地址返回可读 400', invalidLink.status === 400 && invalidLink.body.error === 'invalid_agent_url', invalidLink);

  // 恢复为合法封面，供下一步提交
  step('重新上传合法封面');
  await setFileInput(cdp, '#cover-file', [fixtureOk]);
  const restored = await waitFor(cdp, `({ done: document.getElementById('cover-status')?.textContent === '已上传' })`, 15000);
  check('上传可重复：失败后可再次成功上传', restored.done === true, restored);

  /* ------------------ 2. 管理端：提交全部字段 ------------------ */
  step('填写并提交全部字段');
  const linkUrl = `${BASE}/agents.html?from=card-link`;
  const submit = await evaluate(
    cdp,
    `(async () => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      set('field-name', ${JSON.stringify(agentName)});
      set('field-summary', 'CDP 自动验证：字段完整展示与链接跳转。');
      set('field-tags', '四修复验证,链接');
      set('field-discipline', '工学');
      set('field-major', '计算机科学与技术');
      set('field-course', '数据结构与算法');
      set('field-school', '示例大学');
      set('field-url', ${JSON.stringify(linkUrl)});
      set('field-pain', '验证痛点字段是否完整展示。');
      set('field-guide', '验证使用说明字段是否完整展示。');
      set('field-data', JSON.stringify({ 场景: '四修复验证', 未设置: null, 零值: 0, 布尔值: false }));
      document.getElementById('form-submit').click();
      await new Promise((r) => setTimeout(r, 2600));
      const notice = document.getElementById('create-notice');
      return {
        noticeTone: notice?.dataset.tone ?? '',
        noticeText: notice?.textContent ?? '',
        rows: Array.from(document.querySelectorAll('#agent-rows tr')).map((tr) => tr.innerText).join('\\n'),
        coverCells: document.querySelectorAll('#agent-rows .table-cover').length
      };
    })()`
  );
  check('字段完整：提交成功且提示为成功态', submit.noticeTone === 'success' && /新增成功/.test(submit.noticeText), submit.noticeText);
  check('字段完整：管理端列表出现新记录', submit.rows.includes(agentName), submit.rows.split('\n')[0]);
  check('字段完整：列表渲染封面缩略图', submit.coverCells > 0, submit.coverCells);

  // 反查接口，确认落库字段齐全（同时记录 id 供清理）
  const apiItem = await evaluate(
    cdp,
    `(async () => {
      const res = await fetch('/api/agents?limit=500', { headers: { accept: 'application/json' } });
      const data = await res.json();
      const item = data.items.find((x) => x.name === ${JSON.stringify(agentName)});
      return item ?? null;
    })()`
  );
  check(
    '字段完整：接口列表返回全部已填写字段',
    Boolean(apiItem) &&
      apiItem.discipline === '工学' &&
      apiItem.major === '计算机科学与技术' &&
      apiItem.courseName === '数据结构与算法' &&
      apiItem.schoolName === '示例大学' &&
      apiItem.agentUrl === linkUrl &&
      /^\/uploads\//.test(apiItem.coverImage || ''),
    apiItem
      ? {
          discipline: apiItem.discipline,
          major: apiItem.major,
          courseName: apiItem.courseName,
          schoolName: apiItem.schoolName,
          agentUrl: apiItem.agentUrl,
          coverImage: apiItem.coverImage
        }
      : 'not found'
  );
  if (apiItem?.id) createdAgentIds.push(apiItem.id);
  await shot(cdp, '03-admin-list');

  /* ------------------ 3. 查询平台：卡片展示全部字段 + 链接可点击 ------------------ */
  await navigate(cdp, `${BASE}/agents.html`, '/agents.html');
  await waitFor(
    cdp,
    `({ done: Array.from(document.querySelectorAll('.agent-card-name')).some((el) => el.textContent === ${JSON.stringify(agentName)}) })`,
    15000
  );

  const card = await evaluate(
    cdp,
    `(() => {
      const card = Array.from(document.querySelectorAll('.agent-card')).find((c) => c.querySelector('.agent-card-name').textContent === ${JSON.stringify(agentName)});
      const link = card.querySelector('.agent-link');
      const meta = card.querySelector('.agent-card-meta')?.innerText ?? '';
      const cover = card.querySelector('.agent-card-cover img');
      return {
        meta,
        hasCover: Boolean(cover && cover.complete && cover.naturalWidth > 0),
        linkHref: link?.getAttribute('href') ?? '',
        linkTarget: link?.getAttribute('target') ?? '',
        linkRel: link?.getAttribute('rel') ?? '',
        linkText: link?.innerText.trim() ?? '',
        linkCursor: link ? getComputedStyle(link).cursor : '',
        cardRole: card.getAttribute('role')
      };
    })()`
  );
  check(
    '卡片字段完整：学科 / 专业 / 课程 / 学校全部展示',
    ['工学', '计算机科学与技术', '数据结构与算法', '示例大学'].every((v) => card.meta.includes(v)),
    card.meta.replace(/\n/g, ' | ')
  );
  check('卡片字段完整：封面图渲染', card.hasCover === true);
  check('链接可见：卡片渲染「打开智能体」链接', card.linkText.includes('打开智能体') && card.linkHref === linkUrl, `${card.linkText} → ${card.linkHref}`);
  check('链接安全：新标签打开且带 noopener noreferrer', card.linkTarget === '_blank' && /noopener/.test(card.linkRel) && /noreferrer/.test(card.linkRel), `${card.linkTarget} / ${card.linkRel}`);

  // hover 反馈：先把链接滚到视口内，再用真实鼠标移动触发 :hover
  await evaluate(
    cdp,
    `(() => {
      const card = Array.from(document.querySelectorAll('.agent-card')).find((c) => c.querySelector('.agent-card-name').textContent === ${JSON.stringify(agentName)});
      card.querySelector('.agent-link').scrollIntoView({ block: 'center' });
      return true;
    })()`
  );
  await sleep(500);
  const hover = await evaluate(
    cdp,
    `(() => {
      const card = Array.from(document.querySelectorAll('.agent-card')).find((c) => c.querySelector('.agent-card-name').textContent === ${JSON.stringify(agentName)});
      const link = card.querySelector('.agent-link');
      const before = getComputedStyle(link);
      const box = link.getBoundingClientRect();
      return {
        before: before.borderTopColor + ' | ' + before.backgroundColor,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        inViewport: box.top >= 0 && box.bottom <= window.innerHeight,
        transition: before.transitionDuration
      };
    })()`
  );
  check('链接交互：链接位于视口内可被点击', hover.inViewport === true, { y: Math.round(hover.y), viewport: 900 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(hover.x), y: Math.round(hover.y), buttons: 0 });
  await sleep(420);
  const hoverAfter = await evaluate(
    cdp,
    `(() => {
      const card = Array.from(document.querySelectorAll('.agent-card')).find((c) => c.querySelector('.agent-card-name').textContent === ${JSON.stringify(agentName)});
      const s = getComputedStyle(card.querySelector('.agent-link'));
      return { after: s.borderTopColor + ' | ' + s.backgroundColor };
    })()`
  );
  check('链接交互：hover 有视觉反馈', hover.before !== hoverAfter.after, `${hover.before} → ${hoverAfter.after}`);
  check('链接交互：过渡动画已定义', hover.transition !== '0s', hover.transition);
  await shot(cdp, '04-agents-cards');

  /* ------------------ 4. 链接点击：新标签真实跳转 ------------------ */
  const tabsBefore = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).filter((t) => t.type === 'page').map((t) => t.id);
  // 真实鼠标点击（带用户手势）：同时也验证「点链接不会误开详情弹窗」
  await clickAt(cdp, hover.x, hover.y);
  await sleep(2000);
  const tabsAfter = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).filter((t) => t.type === 'page');
  const newTab = tabsAfter.find((t) => !tabsBefore.includes(t.id));
  const modalStillHidden = await evaluate(cdp, `document.getElementById('detail-backdrop').hidden`);
  check('链接跳转：点击后新标签已打开', Boolean(newTab), newTab ? newTab.url : 'no new target');
  check('链接跳转：新标签地址与智能体链接一致', Boolean(newTab) && newTab.url.startsWith(linkUrl), newTab?.url ?? '');
  check('链接点击不误触发详情弹窗', modalStillHidden === true, modalStillHidden);
  // 新标签真实加载成功（不是错误页）
  let newTabOk = false;
  if (newTab) {
    try {
      const probe = new WebSocket(newTab.webSocketDebuggerUrl);
      await withTimeout(new Promise((r) => probe.addEventListener('open', r, { once: true })), 4000);
      const tabCdp = new CDP(probe);
      await tabCdp.send('Runtime.enable');
      const state = await evaluate(tabCdp, `({ title: document.title, hasGrid: Boolean(document.getElementById('agent-grid')) })`);
      newTabOk = state.hasGrid === true;
      probe.close();
      await fetch(`${CDP_HTTP}/json/close/${newTab.id}`);
    } catch {
      newTabOk = false;
    }
  }
  check('链接跳转：目标页面真实加载完成', newTabOk === true);

  /* ------------------ 5. 详情弹窗：字段 / 字号 / 配色 / 链接 ------------------ */
  await evaluate(
    cdp,
    `(() => {
      const card = Array.from(document.querySelectorAll('.agent-card')).find((c) => c.querySelector('.agent-card-name').textContent === ${JSON.stringify(agentName)});
      card.click();
      return true;
    })()`
  );
  await waitFor(cdp, `({ done: !document.getElementById('detail-backdrop').hidden && document.getElementById('detail-body').innerText.includes('使用说明') })`, 15000);
  await sleep(500);

  const modal = await evaluate(
    cdp,
    `(() => {
      const px = (el, prop) => el ? parseFloat(getComputedStyle(el)[prop]) : 0;
      const modal = document.querySelector('.modal');
      const title = document.getElementById('detail-title');
      const subtitle = document.getElementById('detail-subtitle');
      const body = document.getElementById('detail-body');
      const value = body.querySelector('.kv-value');
      const key = body.querySelector('.kv-key');
      const label = body.querySelector('.section-label');
      const link = body.querySelector('.detail-link-btn');
      const text = body.innerText;
      return {
        text,
        titleSize: px(title, 'fontSize'),
        subtitleSize: px(subtitle, 'fontSize'),
        bodySize: px(body, 'fontSize'),
        valueSize: px(value, 'fontSize'),
        keySize: px(key, 'fontSize'),
        labelSize: px(label, 'fontSize'),
        labelColor: label ? getComputedStyle(label).color : '',
        modalColor: getComputedStyle(modal).backgroundColor,
        linkHref: link?.getAttribute('href') ?? '',
        linkTarget: link?.getAttribute('target') ?? '',
        linkRel: link?.getAttribute('rel') ?? '',
        linkBg: link ? getComputedStyle(link).backgroundImage : '',
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        purpleNodes: Array.from(modal.querySelectorAll('*')).map((el) => getComputedStyle(el).color).filter((c) => { const p = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c); return p && Number(p[1]) > 140 && Number(p[3]) > 140 && Number(p[2]) < Number(p[1]); })
      };
    })()`
  );

  check(
    '弹窗字段完整：学科 / 专业 / 课程 / 学校 / 痛点 / 使用说明 / 扩展字段',
    ['学科门类', '工学', '具体专业', '计算机科学与技术', '课程名称', '数据结构与算法', '所属学校', '示例大学', '痛点', '使用说明', '扩展字段', '四修复验证'].every(
      (t) => modal.text.includes(t)
    ),
    modal.text.slice(0, 90).replace(/\n/g, ' | ')
  );
  check(
    '弹窗字号层级：标题 > 正文 ≥ 16px > 辅助',
    modal.titleSize >= 20 && modal.bodySize >= 15 && modal.valueSize >= 15 && modal.keySize >= 13 && modal.keySize < modal.valueSize && modal.valueSize < modal.titleSize,
    { 标题: modal.titleSize, 副标题: modal.subtitleSize, 正文: modal.bodySize, 值: modal.valueSize, 键: modal.keySize, 分区标签: modal.labelSize }
  );
  check(
    '弹窗配色：分区标签为青绿主色，非紫色系',
    (() => {
      const rgb = parseRgb(modal.labelColor);
      return Boolean(rgb) && rgb.r < 120 && rgb.g > 150 && rgb.b > 150;
    })(),
    modal.labelColor
  );
  check('弹窗配色：弹窗内无紫色系文字', modal.purpleNodes.length === 0, modal.purpleNodes.slice(0, 3));
  check('弹窗链接：渲染「打开智能体」主按钮', modal.linkHref === linkUrl && modal.linkTarget === '_blank' && /noopener/.test(modal.linkRel), `${modal.linkHref} / ${modal.linkTarget} / ${modal.linkRel}`);
  check('弹窗无横向溢出（PC）', modal.scrollWidth <= modal.innerWidth + 1, `${modal.scrollWidth} / ${modal.innerWidth}`);
  const typedFields = await evaluate(cdp, `(() => Object.fromEntries(Array.from(document.querySelectorAll('#detail-body .kv-key')).map(key => [key.textContent, key.nextElementSibling.textContent])))()`);
  check('扩展字段：null / 0 / false 均明确显示', typedFields['未设置'] === 'null' && typedFields['零值'] === '0' && typedFields['布尔值'] === 'false', typedFields);
  await shot(cdp, '05-modal-pc');

  // 弹窗内链接点击 → 新标签（真实鼠标点击，保证有用户手势）
  await evaluate(cdp, `document.querySelector('.detail-link-btn').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  const modalLinkBox = await evaluate(
    cdp,
    `(() => { const b = document.querySelector('.detail-link-btn').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`
  );
  const tabs2 = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).filter((t) => t.type === 'page').map((t) => t.id);
  await clickAt(cdp, modalLinkBox.x, modalLinkBox.y);
  await sleep(2000);
  const tabs3 = (await (await fetch(`${CDP_HTTP}/json/list`)).json()).filter((t) => t.type === 'page');
  const modalTab = tabs3.find((t) => !tabs2.includes(t.id));
  check('弹窗链接跳转：点击后新标签打开目标地址', Boolean(modalTab) && modalTab.url.startsWith(linkUrl), modalTab?.url ?? 'no new target');
  const modalOpenAfterClick = await evaluate(cdp, `!document.getElementById('detail-backdrop').hidden`);
  check('弹窗链接点击后弹窗保持打开（不误关闭）', modalOpenAfterClick === true);
  if (modalTab) await fetch(`${CDP_HTTP}/json/close/${modalTab.id}`);

  /* ------------------ 6. 弹窗样式：hover / 关闭反馈 ------------------ */
  const closeHover = await evaluate(
    cdp,
    `(() => {
      const btn = document.getElementById('detail-close');
      const box = btn.getBoundingClientRect();
      return { before: getComputedStyle(btn).borderTopColor, x: box.x + box.width / 2, y: box.y + box.height / 2, transition: getComputedStyle(btn).transitionDuration };
    })()`
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(closeHover.x), y: Math.round(closeHover.y), buttons: 0 });
  await sleep(400);
  const closeAfter = await evaluate(cdp, `(() => ({ after: getComputedStyle(document.getElementById('detail-close')).borderTopColor }))()`);
  check('弹窗交互：关闭按钮 hover 有视觉反馈', closeHover.before !== closeAfter.after, `${closeHover.before} → ${closeAfter.after}`);
  check('弹窗交互：关闭按钮有过渡动画', closeHover.transition !== '0s', closeHover.transition);

  /* ------------------ 7. 响应式：平板 / 手机 ------------------ */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 834,
    height: 1112,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(500);
  const tablet = await evaluate(
    cdp,
    `(() => {
      const grid = document.getElementById('agent-grid');
      const modal = document.querySelector('.modal');
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        modalWidth: Math.round(modal.getBoundingClientRect().width),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      };
    })()`
  );
  check('平板（834px）：卡片两列且无横向溢出', tablet.columns === 2 && tablet.scrollWidth <= tablet.innerWidth + 1, tablet);
  await shot(cdp, '06-modal-tablet');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });
  await sleep(700);
  const mobile = await evaluate(
    cdp,
    `(() => {
      const grid = document.getElementById('agent-grid');
      const modal = document.querySelector('.modal');
      const body = document.getElementById('detail-body');
      const kv = body.querySelector('.kv-grid');
      const box = modal.getBoundingClientRect();
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        modalBottom: Math.round(box.bottom),
        modalTop: Math.round(box.top),
        innerHeight: window.innerHeight,
        kvColumns: getComputedStyle(kv).gridTemplateColumns.split(' ').length,
        titleSize: parseFloat(getComputedStyle(document.getElementById('detail-title')).fontSize),
        valueSize: parseFloat(getComputedStyle(body.querySelector('.kv-value')).fontSize),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      };
    })()`
  );
  check('手机（390px）：卡片单列', mobile.columns === 1, mobile.columns);
  check('手机（390px）：弹窗贴底为抽屉式', mobile.modalBottom >= mobile.innerHeight - 2 && mobile.modalTop > 40, mobile);
  check('手机（390px）：键值表单列避免挤压', mobile.kvColumns === 1, mobile.kvColumns);
  check('手机（390px）：弹窗字号仍然可读（标题 ≥ 20px / 正文 ≥ 15px）', mobile.titleSize >= 20 && mobile.valueSize >= 15, { 标题: mobile.titleSize, 正文: mobile.valueSize });
  check('手机（390px）：无横向溢出', mobile.scrollWidth <= mobile.innerWidth + 1, `${mobile.scrollWidth} / ${mobile.innerWidth}`);
  await shot(cdp, '07-modal-mobile');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  step('验证同名记录切换与详情失败重试');
  const duplicate = await evaluate(cdp, `(async () => {
    const response = await fetch('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(agentName)}, painPoint: '同名第二条独有痛点', usageGuide: '第二条使用说明' }) });
    const data = await response.json();
    return data.item;
  })()`);
  if (!duplicate?.id) throw new Error('同名记录测试准备失败');
  createdAgentIds.push(duplicate.id);
  await navigate(cdp, `${BASE}/agents.html`, '/agents.html');
  await waitFor(cdp, `({ done: Boolean(document.querySelector('[data-agent-id="${duplicate.id}"]')) })`);
  await evaluate(cdp, `(() => {
    window.__verifyOriginalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.__verifyOriginalFetch(...args);
      if (String(args[0]) === '/api/agents/${apiItem.id}') {
        await new Promise(resolve => { window.__verifyReleaseDetail = resolve; });
        window.__verifyDetailReleased = true;
      }
      return response;
    };
    document.querySelector('[data-agent-id="${apiItem.id}"]').click();
  })()`);
  await waitFor(cdp, `({ done: Boolean(window.__verifyReleaseDetail) })`);
  const loading = await evaluate(cdp, `document.getElementById('detail-body').innerText`);
  check('详情加载中：明确提示等待，不把未加载字段误报为空', /详情加载中/.test(loading) && !/暂无描述|暂无说明/.test(loading), loading);
  await evaluate(cdp, `document.getElementById('detail-close').click(); document.querySelector('[data-agent-id="${duplicate.id}"]').click();`);
  await waitFor(cdp, `({ done: document.getElementById('detail-body').innerText.includes('同名第二条独有痛点') })`);
  await evaluate(cdp, `window.__verifyReleaseDetail();`);
  await waitFor(cdp, `({ done: Boolean(window.__verifyDetailReleased) })`);
  await sleep(100);
  const switched = await evaluate(cdp, `document.getElementById('detail-body').innerText`);
  check('同名智能体：迟到响应不会覆盖当前另一条记录', switched.includes('同名第二条独有痛点') && !switched.includes('验证痛点字段'), switched.slice(0, 130));

  await evaluate(cdp, `(() => {
    window.fetch = window.__verifyOriginalFetch;
    const actual = window.fetch;
    let fail = true;
    window.fetch = (...args) => {
      if (String(args[0]) === '/api/agents/${duplicate.id}' && fail) {
        fail = false;
        return Promise.reject(new Error('浏览器验证：模拟一次网络失败'));
      }
      return actual(...args);
    };
    document.getElementById('detail-close').click();
    document.querySelector('[data-agent-id="${duplicate.id}"]').click();
  })()`);
  await waitFor(cdp, `({ done: Boolean(document.getElementById('detail-retry')) })`);
  const failedDetail = await evaluate(cdp, `document.getElementById('detail-body').innerText`);
  check('详情请求失败：明确错误与重试入口', failedDetail.includes('详情未加载') && failedDetail.includes('重新加载详情') && !/暂无描述|暂无说明/.test(failedDetail), failedDetail);
  await evaluate(cdp, `document.getElementById('detail-retry').click();`);
  const retried = await waitFor(cdp, `({ done: document.getElementById('detail-body').innerText.includes('同名第二条独有痛点') && !document.getElementById('detail-retry') })`);
  check('详情重试：恢复真实接口数据与已填写长字段', retried.done, retried);
  await shot(cdp, '08-detail-retry');

  /* ------------------ 8. 控制台错误 ------------------ */
  const errors = cdp.errors();
  check('全流程无未处理的页面错误', errors.length === 0 && cdp.allExceptions.length === 0, errors.length ? errors.slice(0, 3) : cdp.allExceptions);

  /* ------------------ 收尾 ------------------ */
  const removed = await cleanup();
  const passed = results.filter((r) => r.ok).length;
  await Promise.allSettled(cdp.responseReads);
  const report = { base: BASE, ranAt: new Date().toISOString(), passed, total: results.length, results, requests: [...cdp.requests.values()], cleanup: removed };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n=== ${passed}/${results.length} 通过 ===`);
  console.log('清理结果:', JSON.stringify(removed));
  ws.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (error) => {
  console.error('验证脚本异常:', error);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
