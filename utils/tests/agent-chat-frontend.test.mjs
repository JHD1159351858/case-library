import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { renderAgentLink, resolveAgentLink } from '../../project/frontend/js/session.js';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function page(fetchJson) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, { hidden: true, value: '', textContent: '', innerHTML: '', disabled: false,
        focus() {}, addEventListener(type, callback) { listeners.set(type, callback); },
        emit(type, event = {}) { return listeners.get(type)?.({ target: this, preventDefault() {}, ...event }); } });
    }
    return nodes.get(id);
  };
  const keyEvents = new Map();
  const document = { getElementById: get, body: { style: { overflow: 'auto' } }, addEventListener(type, cb) { keyEvents.set(type, cb); } };
  const details = [];
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const context = createContext({ document, fetchJson, escapeHtml, renderAgentLink, resolveAgentLink, AbortController });
  const source = readFileSync(new URL('../../project/frontend/js/agent-chat.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '') + '\nglobalThis.init = initAgentChat;', context);
  const api = context.init({ openDetail: (id, item) => details.push({ id, item }) });
  return { api, get, document, keyEvents, details };
}

test('聊天入口：打开与关闭恢复滚动，未配置返回明确提示且保留输入', async () => {
  const calls = [];
  const ui = page(async (url, options) => { calls.push({ url, options }); return { ok: false, data: { error: 'ai_not_configured' } }; });
  ui.api.open();
  assert.equal(ui.document.body.style.overflow, 'hidden');
  ui.get('agent-chat-input').value = ' 找实验预习智能体 ';
  await ui.get('agent-chat-form').emit('submit');
  assert.equal(calls[0].url, '/api/agents/chat');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { messages: [{ role: 'user', content: '找实验预习智能体' }] });
  assert.match(ui.get('agent-chat-status').textContent, /AI 尚未接入/);
  assert.equal(ui.get('agent-chat-input').value, ' 找实验预习智能体 ');
  assert.equal(ui.get('agent-chat-send').disabled, false);
  assert.equal(ui.get('agent-chat-messages').innerHTML, '');
  ui.keyEvents.get('keydown')({ key: 'Escape' });
  assert.equal(ui.get('agent-chat-backdrop').hidden, true);
  assert.equal(ui.document.body.style.overflow, 'auto');
});

test('聊天入口：只发送有效需求，加载时阻止重复提交', async () => {
  const request = deferred();
  let calls = 0;
  const ui = page(async () => { ++calls; return request.promise; });
  ui.api.open();
  ui.get('agent-chat-input').value = ' ';
  await ui.get('agent-chat-form').emit('submit');
  ui.get('agent-chat-input').value = 'x'.repeat(2001);
  await ui.get('agent-chat-form').emit('submit');
  assert.equal(calls, 0);
  ui.get('agent-chat-input').value = '课程问答';
  const pending = ui.get('agent-chat-form').emit('submit');
  assert.equal(ui.get('agent-chat-send').disabled, true);
  await ui.get('agent-chat-form').emit('submit');
  assert.equal(calls, 1);
  request.resolve({ ok: false, data: { error: 'ai_not_configured' } });
  await pending;
});

test('聊天入口：成功回复转义文字，真实推荐可打开跨页详情，多轮发送保留上下文', async () => {
  const bodies = [];
  const item = { id: 'off-page', name: '<案例>', major: '计算机', schoolName: '示例大学' };
  const ui = page(async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, data: { reply: '<script>推荐</script>', items: [item] } }; });
  ui.api.open();
  ui.get('agent-chat-input').value = '<需求>';
  await ui.get('agent-chat-form').emit('submit');
  assert.equal(ui.get('agent-chat-input').value, '');
  assert.match(ui.get('agent-chat-messages').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.get('agent-chat-messages').innerHTML, /<script>/);
  assert.match(ui.get('agent-chat-messages').innerHTML, /&lt;案例&gt;/);
  ui.get('agent-chat-input').value = '需要课后使用';
  await ui.get('agent-chat-form').emit('submit');
  assert.deepEqual(bodies[1].messages.map(({ role }) => role), ['user', 'assistant', 'user']);
  ui.get('agent-chat-messages').emit('click', { target: { closest: () => ({ dataset: { chatAgentId: 'off-page' } }) } });
  assert.equal(ui.details[0].id, item.id);
  assert.equal(ui.details[0].item.name, item.name);
  assert.equal(ui.get('agent-chat-backdrop').hidden, true);
});

test('聊天入口：关闭取消请求，重开后的迟到结果不更新界面', async () => {
  const request = deferred();
  let signal;
  const ui = page(async (_url, options) => { signal = options.signal; return request.promise; });
  ui.api.open();
  ui.get('agent-chat-input').value = '实验智能体';
  const pending = ui.get('agent-chat-form').emit('submit');
  ui.api.close();
  assert.equal(signal.aborted, true);
  ui.api.open();
  request.resolve({ ok: true, data: { reply: '过期回复', items: [] } });
  await pending;
  assert.doesNotMatch(ui.get('agent-chat-messages').innerHTML, /过期回复/);
  assert.equal(ui.get('agent-chat-input').value, '实验智能体');
  assert.equal(ui.get('agent-chat-send').disabled, false);
});

test('聊天入口：网络或无效回复失败保留需求，支持重试', async () => {
  for (const response of [null, { ok: true, data: { reply: 123, items: [] } }, { ok: false, data: { error: 'ai_unavailable' } }]) {
    const ui = page(async () => { if (!response) throw new Error('offline'); return response; });
    ui.api.open();
    ui.get('agent-chat-input').value = '希望找到学习伙伴';
    await ui.get('agent-chat-form').emit('submit');
    assert.equal(ui.get('agent-chat-input').value, '希望找到学习伙伴');
    assert.equal(ui.get('agent-chat-send').disabled, false);
    assert.match(ui.get('agent-chat-status').textContent, /保留/);
  }
});

test('聊天入口：多轮上下文有界，发送最多19条、最后一条为用户需求', async () => {
  const bodies = [];
  const ui = page(async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, data: { reply: '请补充用途', items: [] } }; });
  ui.api.open();
  for (let i = 0; i < 12; ++i) {
    ui.get('agent-chat-input').value = `需求${i}`;
    await ui.get('agent-chat-form').emit('submit');
  }
  assert.equal(bodies.at(-1).messages.length, 19);
  assert.equal(bodies.at(-1).messages.at(-1).role, 'user');
  assert.equal(bodies.at(-1).messages.at(-1).content, '需求11');
});

test('聊天推荐：数据库网址直接显示为安全的新标签链接，保留详情入口', async () => {
  const items = [
    { id: 'external', name: '课程问答', agentUrl: 'https://agents.example/chat?a=1&b=2', matchScore: 99, matchReason: '适合课程问答' },
    { id: 'internal', name: '实验预习', agentUrl: '/agents.html?demo=lab-guide' }
  ];
  const ui = page(async () => ({ ok: true, data: { reply: '推荐案例 https://invented.example', items } }));
  ui.api.open();
  ui.get('agent-chat-input').value = '找学习工具';
  await ui.get('agent-chat-form').emit('submit');
  const html = ui.get('agent-chat-messages').innerHTML;
  assert.match(html, /href="https:\/\/agents\.example\/chat\?a=1&amp;b=2"/);
  assert.match(html, /href="\/agents\.html\?demo=lab-guide"/);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
  assert.equal((html.match(/data-chat-agent-id=/g) || []).length, 2);
  assert.match(html, /class="detail-link-url mono">https:\/\/agents\.example\/chat\?a=1&amp;b=2<\/span>/);
  assert.doesNotMatch(html, /href="https:\/\/invented\.example/);
  assert.match(ui.get('agent-chat-status').textContent, /打开智能体/);
});

test('聊天推荐：缺失或危险网址不生成链接，明确显示不可用', async () => {
  const items = ['', 'javascript:alert(1)', 'data:text/html,test', '//evil.example', '/\\evil.example', 'https:']
    .map((agentUrl, index) => ({ id: `invalid${index}`, name: '案例', agentUrl }));
  const ui = page(async () => ({ ok: true, data: { reply: '推荐案例', items } }));
  ui.api.open();
  ui.get('agent-chat-input').value = '找案例';
  await ui.get('agent-chat-form').emit('submit');
  const html = ui.get('agent-chat-messages').innerHTML;
  assert.doesNotMatch(html, /<a\b/);
  assert.equal((html.match(/暂无可用链接/g) || []).length, items.length);
});

test('聊天推荐：点击网址不关闭对话或打开详情，原详情按钮仍正常', async () => {
  const item = { id: 'linked', name: '课程问答', agentUrl: 'https://agents.example/', matchScore: 99, matchReason: '适合课程问答' };
  const ui = page(async () => ({ ok: true, data: { reply: '推荐案例', items: [item] } }));
  ui.api.open();
  ui.get('agent-chat-input').value = '找问答工具';
  await ui.get('agent-chat-form').emit('submit');
  ui.get('agent-chat-messages').emit('click', { target: { closest: () => null } });
  assert.equal(ui.get('agent-chat-backdrop').hidden, false);
  assert.equal(ui.details.length, 0);
  ui.get('agent-chat-messages').emit('click', { target: { closest: () => ({ dataset: { chatAgentId: item.id } }) } });
  assert.equal(ui.details[0].id, item.id);
});

test('聊天推荐：显示接口评分和匹配理由，理由转义并说明为 AI 参考评分', async () => {
  const item = { id: 'scored', name: '课程问答', matchScore: 99, matchReason: '<img src=x onerror="alert(1)"> & 适合课程问答' };
  const ui = page(async () => ({ ok: true, data: { reply: '推荐案例', items: [item] } }));
  ui.api.open();
  ui.get('agent-chat-input').value = '找问答工具';
  await ui.get('agent-chat-form').emit('submit');
  const html = ui.get('agent-chat-messages').innerHTML;
  assert.match(html, /class="agent-chat-match-score">匹配度 99%<\/span>/);
  assert.match(html, /class="agent-chat-match-reason">&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; 适合课程问答<\/p>/);
  assert.doesNotMatch(html, /<img\b/);
  assert.match(ui.get('agent-chat-availability').textContent, /AI 参考评分/);
});

test('聊天推荐：仅显示 0 到 100 的整数评分，缺失和非法评分不填造百分比', async () => {
  const scores = [0, 100, undefined, null, -1, 101, 99.5, '99', NaN, Infinity];
  const items = scores.map((matchScore, index) => ({ id: `score-${index}`, name: '课程问答', matchScore }));
  const ui = page(async () => ({ ok: true, data: { reply: '推荐案例', items } }));
  ui.api.open();
  ui.get('agent-chat-input').value = '找问答工具';
  await ui.get('agent-chat-form').emit('submit');
  const html = ui.get('agent-chat-messages').innerHTML;
  assert.match(html, /class="agent-chat-match-score">匹配度 0%<\/span>/);
  assert.match(html, /class="agent-chat-match-score">匹配度 100%<\/span>/);
  assert.equal((html.match(/class="agent-chat-match-score"/g) || []).length, 2);
  assert.doesNotMatch(html, /匹配度 99%/);
});

test('聊天推荐：没有推荐案例时不显示评分或匹配理由', async () => {
  const ui = page(async () => ({ ok: true, data: { reply: '请补充需求', items: [], matchScore: 99, matchReason: '响应顶层不是案例' } }));
  ui.api.open();
  ui.get('agent-chat-input').value = '找工具';
  await ui.get('agent-chat-form').emit('submit');
  assert.doesNotMatch(ui.get('agent-chat-messages').innerHTML, /agent-chat-match-score|agent-chat-match-reason|匹配度 99%|响应顶层不是案例/);
});
