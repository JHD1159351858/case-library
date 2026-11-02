import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const moduleUrl = new URL('../../project/frontend/js/site-visits.js', import.meta.url);

test('网站访问前端：加载时仅发起一次同源上报，不发送客户端身份', () => {
  const calls = [];
  runInNewContext(readFileSync(moduleUrl, 'utf8'), {
    fetch: (url, options) => { calls.push([url, options]); return Promise.resolve({ ok: true }); }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/site-visits');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].keepalive, true);
  assert.equal(calls[0][1].body, undefined);
});

test('网站访问前端：网络失败已捕获，不重试、不影响页面初始化', () => {
  let caught = false;
  runInNewContext(readFileSync(moduleUrl, 'utf8'), {
    fetch: () => ({ catch(handler) { caught = true; assert.doesNotThrow(() => handler(new Error('offline'))); } })
  });
  assert.equal(caught, true);
});
