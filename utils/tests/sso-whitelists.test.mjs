import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSsoWhitelistClient } from '../../project/backend/sso-whitelists.mjs';

const token = 'integration-test-token-01234567890123456789';
const success = (data) => ({ ok: true, status: 200, json: async () => data });

test('SSO白名单代理：只访问固定机构/域名接口，管理密钥和真实操作者仅发给认证中心', async () => {
  const calls = [];
  const client = createSsoWhitelistClient({ centerUrl: 'https://center.example/some/path', token, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return success({ ok: true, items: url.endsWith('/fids')
      ? [{ fid: '123', name: '测试学校', enabled: true, created_by: 'private-admin' }]
      : [{ origin: 'https://project.example', note: '测试项目', enabled: false }] });
  } });
  const result = await client.read('owner-uid');
  assert.deepEqual(result, { fids: [{ fid: '123', name: '测试学校', enabled: true }], origins: [{ origin: 'https://project.example', note: '测试项目', enabled: false }] });
  assert.deepEqual(calls.map(({ url }) => url).sort(), ['https://center.example/api/admin/fids', 'https://center.example/api/admin/origins']);
  for (const { options } of calls) {
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.headers['x-case-library-actor'], 'owner-uid');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes('private-admin'));
});

test('SSO白名单代理：八种操作遵守现有认证中心契约，每次写入只发一次', async () => {
  const calls = [];
  const client = createSsoWhitelistClient({ centerUrl: 'https://center.example', token, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return success({ ok: true });
  } });
  const cases = [
    [{ kind: 'fid', action: 'add', fid: ' 123 ', name: ' 测试 ' }, 'POST', '/fids', { fid: '123', name: '测试' }],
    [{ kind: 'fid', action: 'enable', fid: '123' }, 'PATCH', '/fids/123', { enabled: true }],
    [{ kind: 'fid', action: 'disable', fid: '123' }, 'PATCH', '/fids/123', { enabled: false }],
    [{ kind: 'fid', action: 'delete', fid: '123' }, 'DELETE', '/fids/123', undefined],
    [{ kind: 'origin', action: 'add', origin: 'https://project.example/', note: ' 项目 ' }, 'POST', '/origins', { origin: 'https://project.example', note: '项目' }],
    [{ kind: 'origin', action: 'enable', origin: 'https://project.example' }, 'POST', '/origins/action', { origin: 'https://project.example', enabled: true }],
    [{ kind: 'origin', action: 'disable', origin: 'https://project.example' }, 'POST', '/origins/action', { origin: 'https://project.example', enabled: false }],
    [{ kind: 'origin', action: 'delete', origin: 'https://project.example' }, 'POST', '/origins/action', { origin: 'https://project.example', delete: true }]
  ];
  for (const [command, method, path, body] of cases) {
    assert.deepEqual(await client.write(command, 'owner-uid'), { ok: true });
    assert.deepEqual(calls.at(-1), { url: `https://center.example/api/admin${path}`, method, body });
  }
  assert.equal(calls.length, 8);
});

test('SSO白名单代理：非法操作、字段、FID和域名在请求认证中心前拒绝', async () => {
  let requests = 0;
  const client = createSsoWhitelistClient({ centerUrl: 'https://center.example', token, fetchImpl: async () => { requests++; return success({ ok: true }); } });
  for (const command of [null, [], {}, { kind: 'users', action: 'delete', fid: '1' },
    { kind: 'fid', action: 'add', fid: '../password' }, { kind: 'fid', action: 'enable', fid: 123 },
    { kind: 'fid', action: 'add', fid: '1', name: {}, actor: 'forged' },
    ...['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?q=1', 'https://example.com#part'].map(origin => ({ kind: 'origin', action: 'add', origin }))]) {
    await assert.rejects(() => client.write(command, 'owner-uid'), { status: 400, code: 'sso_whitelist_invalid_input' });
  }
  assert.equal(requests, 0);
});

test('SSO白名单代理：拒绝授权/断网/超时不会泄漏密钥，也不会重试写入', async () => {
  for (const [makeResponse, status, code] of [
    [() => ({ ok: false, status: 401 }), 502, 'sso_whitelist_center_unauthorized'],
    [() => ({ ok: false, status: 409 }), 409, 'sso_whitelist_conflict'],
    [() => { throw new Error(token); }, 502, 'sso_whitelist_center_unavailable'],
    [() => { throw new DOMException(token, 'TimeoutError'); }, 504, 'sso_whitelist_center_timeout'],
    [() => success({ ok: false, error: token }), 502, 'sso_whitelist_center_unavailable']
  ]) {
    let calls = 0;
    const client = createSsoWhitelistClient({ centerUrl: 'https://center.example', token, fetchImpl: async () => { calls++; return makeResponse(); } });
    await assert.rejects(() => client.write({ kind: 'fid', action: 'add', fid: '1' }, 'owner-uid'), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(token));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('SSO白名单代理：读取失败或返回格式错误不得伪装成空白名单', async () => {
  for (const response of [{ ok: false, status: 404 }, success({ ok: true, items: [{ fid: '1', name: '', enabled: 'false' }] })]) {
    const client = createSsoWhitelistClient({ centerUrl: 'https://center.example', token, fetchImpl: async () => response });
    await assert.rejects(() => client.read('owner-uid'), { status: 502, code: 'sso_whitelist_center_unavailable' });
  }
});

test('SSO白名单代理：远程HTTP不发送管理密钥，仅允许HTTPS及本地回环开发地址', () => {
  let requests = 0;
  const options = { token, fetchImpl: async () => { requests++; return success({ ok: true }); } };
  for (const centerUrl of ['http://center.example', 'https://user:pass@center.example', 'file:///tmp/center']) {
    assert.throws(() => createSsoWhitelistClient({ ...options, centerUrl }), { status: 503, code: 'sso_whitelist_not_configured' });
  }
  for (const centerUrl of ['https://center.example', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    assert.doesNotThrow(() => createSsoWhitelistClient({ ...options, centerUrl }));
  }
  assert.equal(requests, 0);
});

test('SSO白名单代理：Unicode UID编码为ASCII header，不影响中心恢复真实操作者', async () => {
  let actor;
  const client = createSsoWhitelistClient({ centerUrl: 'https://center.example', token, fetchImpl: async (_, options) => {
    actor = options.headers['x-case-library-actor'];
    return success({ ok: true });
  } });
  await client.write({ kind: 'fid', action: 'add', fid: '1' }, '中文🙂');
  assert.equal(actor, encodeURIComponent('中文🙂'));
});
