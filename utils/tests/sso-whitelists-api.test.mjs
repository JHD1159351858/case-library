import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '../../project/backend/database.mjs';
import { createRequestHandler, hashToken, parseEnvConfig } from '../../project/backend/server.mjs';

const integrationToken = 'integration-test-token-01234567890123456789';

async function fixture(run, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sso-white-api-'));
  const db = createDatabase({ databasePath: join(directory, 'test.db') });
  const cookies = {};
  for (const [id, role] of [['owner', 'admin'], ['other-admin', 'admin'], ['student', 'student']]) {
    const identity = { ssoUid: id, name: id, displayName: id, role, roles: [role], openid: '', fid: '', orgName: '' };
    const user = db.upsertUserFromIdentity(identity, role === 'admin', Date.now());
    const token = `session-${id}`;
    db.createSession({ userId: user.id, tokenHash: hashToken(token), createdAt: Date.now(), expiresAt: Date.now() + 60000 });
    cookies[id] = `agent_site_session=${token}`;
  }
  const requests = [];
  const config = parseEnvConfig({}, { host: '127.0.0.1', ssoCenterUrl: 'https://center.example', ssoWhitelistAdminToken: integrationToken, ssoWhitelistAdminUids: 'owner', ...overrides });
  const server = createServer(createRequestHandler({ db, config, logger: { info() {}, warn() {}, error() {} }, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => options.method === 'GET' ? { ok: true, items: [] } : { ok: true } };
  } }));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (options = {}) => {
      const response = await fetch(`${base}/api/sso-whitelists`, options);
      return { status: response.status, data: await response.json(), headers: response.headers };
    };
    await run({ call, cookies, requests, base, config });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('认证名单API：仅指定UID且已有管理员权限可查看/修改，其他案例管理权限不被提升', async () => {
  await fixture(async ({ call, cookies, requests }) => {
    assert.equal((await call()).status, 401);
    for (const id of ['student', 'other-admin']) {
      assert.equal((await call({ headers: { cookie: cookies[id] } })).status, 403);
      assert.equal((await call({ method: 'POST', headers: { cookie: cookies[id], 'content-type': 'application/json' }, body: '{"kind":"fid","action":"delete","fid":"1"}' })).status, 403);
    }
    assert.equal(requests.length, 0);
    const result = await call({ headers: { cookie: cookies.owner, authorization: 'Bearer client-controlled' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { fids: [], origins: [] });
    assert.ok(!JSON.stringify(result.data).includes(integrationToken));
    assert.ok(requests.every(({ options }) => options.headers.authorization === `Bearer ${integrationToken}`));
  });
});

test('认证名单API：跨站写入、伪造actor和非法请求不能执行；操作者来自实际会话', async () => {
  await fixture(async ({ call, cookies, requests, base }) => {
    const headers = { cookie: cookies.owner, 'content-type': 'application/json' };
    const body = JSON.stringify({ kind: 'fid', action: 'enable', fid: '1' });
    for (const extra of [{ origin: 'https://other.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await call({ method: 'POST', headers: { ...headers, ...extra }, body })).status, 403);
    }
    assert.equal(requests.length, 0);
    assert.equal((await call({ method: 'POST', headers, body: 'null' })).status, 400);
    const saved = await call({ method: 'POST', headers: { ...headers, origin: base, 'x-case-library-actor': 'forged' }, body });
    assert.equal(saved.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers['x-case-library-actor'], 'owner');
    assert.equal((await call({ method: 'DELETE', headers })).status, 405);
  });
});

test('认证名单API：没有配置指定UID默认拒绝，缺失或短管理密钥不开启集成', async () => {
  await fixture(async ({ call, cookies, requests }) => {
    assert.equal((await call({ headers: { cookie: cookies.owner } })).status, 403);
    assert.equal(requests.length, 0);
  }, { ssoWhitelistAdminUids: '' });
  for (const token of ['', 'short-token']) {
    await fixture(async ({ call, cookies, requests }) => {
      const response = await call({ headers: { cookie: cookies.owner } });
      assert.equal(response.status, 503);
      assert.equal(response.data.error, 'sso_whitelist_not_configured');
      assert.equal(requests.length, 0);
    }, { ssoWhitelistAdminToken: token });
  }
  await fixture(async ({ call, cookies, requests }) => {
    assert.equal((await call({ headers: { cookie: cookies.owner } })).status, 503);
    assert.equal(requests.length, 0);
  }, { ssoSharedSecret: integrationToken });
});

test('认证名单API：UID指定但不再是管理员、或非JSON写请求，均不能管理名单', async () => {
  await fixture(async ({ call, cookies, requests }) => {
    assert.equal((await call({ headers: { cookie: cookies.student } })).status, 403);
    assert.equal(requests.length, 0);
  }, { ssoWhitelistAdminUids: 'student' });
  await fixture(async ({ call, cookies, requests }) => {
    const result = await call({ method: 'POST', headers: { cookie: cookies.owner, 'content-type': 'text/plain' }, body: '{"kind":"fid","action":"delete","fid":"1"}' });
    assert.equal(result.status, 400);
    assert.equal(requests.length, 0);
  });
});
