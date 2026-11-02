import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const moduleUrl = new URL('../../project/frontend/js/sso-whitelists.js', import.meta.url);

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }
  append(...children) {
    for (const child of children) {
      if (child == null) continue;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute(name, value) { this[name] = String(value); }
  dispatch(type, event = {}) {
    return this.listeners.get(type)?.({ target: this, currentTarget: this, preventDefault() {}, ...event });
  }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function byId(root, id) {
  return find(root, (element) => element.id === id);
}

function actionButton(root, kind, action, key) {
  return find(root, (element) => element.dataset.kind === kind && element.dataset.action === action && element.dataset.key === key);
}

function page(fetchJson, user = { isAdmin: true, ssoUid: 'admin-uid' }) {
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const context = createContext({ document, fetchJson, escapeHtml: (value) => String(value), URL });
  let source = readFileSync(moduleUrl, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  runInContext(`${source}\nglobalThis.api = { initSsoWhitelists };`, context);
  const root = new FakeElement('details');
  return { root, user, init: () => context.api.initSsoWhitelists({ root, user }) };
}

const lists = (overrides = {}) => ({
  fids: [{ fid: '1001', name: '示例机构', enabled: false }],
  origins: [{ origin: 'https://example.edu', note: '示例项目', enabled: true }],
  ...overrides
});

test('SSO 白名单：未获授权时显示当前 UID 和明确提示并禁止操作', async () => {
  const { root, init } = page(async () => ({
    ok: false,
    status: 403,
    data: { error: 'sso_whitelist_forbidden' }
  }));
  await init();
  assert.equal(byId(root, 'sso-whitelists-operator').textContent, 'admin-uid');
  assert.match(byId(root, 'sso-whitelists-status').textContent, /未获认证中心白名单管理授权/);
  assert.equal(byId(root, 'sso-fid-add').disabled, true);
  assert.equal(byId(root, 'sso-origin-add').disabled, true);
});

test('SSO 白名单：新增机构和回跳域名提交准确 payload 并读回', async () => {
  const writes = [];
  let current = lists({ fids: [], origins: [] });
  const { root, init } = page(async (url, options) => {
    assert.equal(url, '/api/sso-whitelists');
    if (options?.method === 'POST') {
      const payload = JSON.parse(options.body);
      writes.push(payload);
      current = payload.kind === 'fid'
        ? { ...current, fids: [{ fid: payload.fid, name: payload.name, enabled: true }] }
        : { ...current, origins: [{ origin: payload.origin, note: payload.note, enabled: true }] };
      return { ok: true, data: { ok: true } };
    }
    return { ok: true, data: current };
  });
  await init();

  byId(root, 'sso-fid').value = '2002';
  byId(root, 'sso-fid-name').value = '第二机构';
  await byId(root, 'sso-fid-form').dispatch('submit');
  byId(root, 'sso-origin').value = 'https://course.example.edu';
  byId(root, 'sso-origin-note').value = '课程站';
  await byId(root, 'sso-origin-form').dispatch('submit');

  assert.deepEqual(writes, [
    { kind: 'fid', action: 'add', fid: '2002', name: '第二机构' },
    { kind: 'origin', action: 'add', origin: 'https://course.example.edu', note: '课程站' }
  ]);
  assert.match(byId(root, 'sso-whitelists-status').textContent, /已保存并刷新/);
});

test('SSO 白名单：名称和备注可留空，FID 仅允许不超过 32 位数字', async () => {
  const writes = [];
  const { root, init } = page(async (_url, options) => {
    if (options?.method === 'POST') {
      writes.push(JSON.parse(options.body));
      return { ok: true, data: { ok: true } };
    }
    return { ok: true, data: lists({ fids: [], origins: [] }) };
  });
  await init();
  assert.equal(byId(root, 'sso-fid').maxLength, 32);
  assert.equal(byId(root, 'sso-fid-name').maxLength, 200);
  assert.equal(byId(root, 'sso-origin-note').maxLength, 200);

  byId(root, 'sso-fid').value = '1'.repeat(33);
  byId(root, 'sso-fid-name').value = '超长 FID';
  await byId(root, 'sso-fid-form').dispatch('submit');
  assert.equal(writes.length, 0);

  const validFid = '2'.repeat(32);
  byId(root, 'sso-fid').value = validFid;
  byId(root, 'sso-fid-name').value = '';
  await byId(root, 'sso-fid-form').dispatch('submit');
  byId(root, 'sso-origin').value = 'https://optional.example.edu';
  byId(root, 'sso-origin-note').value = '';
  await byId(root, 'sso-origin-form').dispatch('submit');
  assert.deepEqual(writes, [
    { kind: 'fid', action: 'add', fid: validFid, name: '' },
    { kind: 'origin', action: 'add', origin: 'https://optional.example.edu', note: '' }
  ]);
});

test('SSO 白名单：启停和二次确认删除发送正确操作', async () => {
  const writes = [];
  const { root, init } = page(async (_url, options) => {
    if (options?.method === 'POST') {
      writes.push(JSON.parse(options.body));
      return { ok: true, data: { ok: true } };
    }
    return { ok: true, data: lists() };
  });
  await init();

  await actionButton(root, 'fid', 'enable', '1001').dispatch('click');
  await actionButton(root, 'origin', 'disable', 'https://example.edu').dispatch('click');
  const remove = actionButton(root, 'origin', 'delete', 'https://example.edu');
  await remove.dispatch('click');
  assert.equal(writes.length, 2);
  await remove.dispatch('click');

  assert.deepEqual(writes, [
    { kind: 'fid', action: 'enable', fid: '1001' },
    { kind: 'origin', action: 'disable', origin: 'https://example.edu' },
    { kind: 'origin', action: 'delete', origin: 'https://example.edu' }
  ]);
});

test('SSO 白名单：写成功但读回失败保留输入且阻止重复写入', async () => {
  let reads = 0;
  let writes = 0;
  const { root, init } = page(async (_url, options) => {
    if (options?.method === 'POST') {
      writes++;
      return { ok: true, data: { ok: true } };
    }
    reads++;
    return reads === 1
      ? { ok: true, data: lists({ fids: [], origins: [] }) }
      : { ok: false, status: 502, data: { error: 'sso_whitelist_center_unavailable' } };
  });
  await init();
  byId(root, 'sso-fid').value = '3003';
  byId(root, 'sso-fid-name').value = '待确认机构';
  await byId(root, 'sso-fid-form').dispatch('submit');

  assert.equal(byId(root, 'sso-fid').value, '3003');
  assert.match(byId(root, 'sso-whitelists-status').textContent, /请求已提交但刷新失败，请刷新确认/);
  assert.equal(byId(root, 'sso-fid-add').disabled, true);
  await byId(root, 'sso-fid-form').dispatch('submit');
  assert.equal(writes, 1);
});

test('SSO 白名单：处理中禁用控件并忽略并发写请求', async () => {
  let resolveWrite;
  let writes = 0;
  let reads = 0;
  const pending = new Promise((resolve) => { resolveWrite = resolve; });
  const { root, init } = page(async (_url, options) => {
    if (options?.method === 'POST') {
      writes++;
      return pending;
    }
    reads++;
    return { ok: true, data: lists({ fids: [], origins: [] }) };
  });
  await init();
  byId(root, 'sso-origin').value = 'https://new.example.edu';
  byId(root, 'sso-origin-note').value = '新站点';
  const first = byId(root, 'sso-origin-form').dispatch('submit');
  const second = byId(root, 'sso-origin-form').dispatch('submit');
  assert.equal(writes, 1);
  assert.equal(byId(root, 'sso-origin-add').disabled, true);
  resolveWrite({ ok: false, status: 504, data: { error: 'sso_whitelist_center_timeout' } });
  await Promise.all([first, second]);
  assert.equal(reads, 2);
  assert.equal(byId(root, 'sso-origin').value, 'https://new.example.edu');
  assert.match(byId(root, 'sso-whitelists-status').textContent, /提交结果未确认，已刷新名单，请核对后再操作/);
});

test('SSO 白名单：POST 超时后只读回一次，读回失败锁定写操作并保留输入', async () => {
  let reads = 0;
  let writes = 0;
  const { root, init } = page(async (_url, options) => {
    if (options?.method === 'POST') {
      writes++;
      return { ok: false, status: 504, data: { error: 'sso_whitelist_center_timeout' } };
    }
    reads++;
    return reads === 1
      ? { ok: true, data: lists({ fids: [], origins: [] }) }
      : { ok: false, status: 502, data: { error: 'sso_whitelist_center_unavailable' } };
  });
  await init();
  byId(root, 'sso-fid').value = '4004';
  byId(root, 'sso-fid-name').value = '状态未知';
  await byId(root, 'sso-fid-form').dispatch('submit');

  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(byId(root, 'sso-fid').value, '4004');
  assert.equal(byId(root, 'sso-fid-name').value, '状态未知');
  assert.equal(byId(root, 'sso-fid-add').disabled, true);
  assert.match(byId(root, 'sso-whitelists-status').textContent, /提交结果未确认，刷新失败，请刷新确认/);
  await byId(root, 'sso-fid-form').dispatch('submit');
  assert.equal(writes, 1);
});
