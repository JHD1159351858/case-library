import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as backend from '../../project/backend/server.mjs';

test('对话消息：去除首尾空白和多余字段，不改变原始消息', () => {
  const messages = [
    { role: 'user', content: ' 找一个课程智能体 ', userId: '不应传给 AI' },
    { role: 'assistant', content: ' 哪门课程？\n' },
    { role: 'user', content: '\n 数据结构 ' }
  ];
  const snapshot = structuredClone(messages);
  assert.deepEqual(backend.normalizeAgentChatMessages(messages), [
    { role: 'user', content: '找一个课程智能体' },
    { role: 'assistant', content: '哪门课程？' },
    { role: 'user', content: '数据结构' }
  ]);
  assert.deepEqual(messages, snapshot);
});

test('对话消息：接受一条或二十条，正文 trim 后最多两千字符', () => {
  const single = [{ role: 'user', content: ` ${'中'.repeat(2000)} ` }];
  assert.equal(backend.normalizeAgentChatMessages(single)[0].content.length, 2000);
  const twenty = Array.from({ length: 20 }, (_, index) => ({
    role: index === 19 ? 'user' : 'assistant', content: `消息 ${index}`
  }));
  assert.equal(backend.normalizeAgentChatMessages(twenty).length, 20);
});

test('对话消息：拒绝缺省、非数组、数量越界、非对象消息和不支持的角色', () => {
  for (const messages of [undefined, null, {}, '', [],
    Array.from({ length: 21 }, () => ({ role: 'user', content: '问题' })),
    [null], [[]], ['text'], [{ content: '问题' }], [{ role: 'system', content: '问题' }]
  ]) {
    assert.equal(backend.normalizeAgentChatMessages(messages), null, JSON.stringify(messages));
  }
});

test('对话消息：拒绝非文本、空白、超长内容和非用户结尾', () => {
  for (const content of [undefined, null, 1, [], {}, '', ' \n ', 'x'.repeat(2001)]) {
    assert.equal(backend.normalizeAgentChatMessages([{ role: 'user', content }]), null);
  }
  assert.equal(backend.normalizeAgentChatMessages([{ role: 'assistant', content: '回答' }]), null);
  assert.equal(backend.normalizeAgentChatMessages([
    { role: 'user', content: '问题' }, { role: 'assistant', content: '回答' }
  ]), null);
});
