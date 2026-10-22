import assert from 'node:assert/strict';
import { test } from 'node:test';

const coze = await import('../../project/backend/coze-agent-chat.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
function provider(dependencies = {}, config = { token: 'unit-test-token', botId: '123456' }) {
  assert.equal(typeof coze.createCozeAgentChatProvider, 'function', '缺少扣子接入函数');
  return coze.createCozeAgentChatProvider(config, dependencies);
}
const agents = [{ id: 'case_a', name: '实验指导', status: 'active', discipline: '理学', major: '化学',
  courseName: '有机化学实验', schoolName: '测试学校', summary: '实验预习', painPoint: '不清楚操作顺序',
  usageGuide: '先描述实验', tags: '预习', data: { 适用对象: '学生' }, created_by: '不应发送',
  visitor_key: '不应发送', agentUrl: '/real-link' }];
const input = { messages: [{ role: 'user', content: '找实验预习智能体' }], agents };
const answer = { reply: '推荐实验指导案例，适合了解操作顺序。', agentIds: ['case_a'] };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const message = (content, extra = {}) => ({ id: 'msg_answer', role: 'assistant', type: 'answer', content_type: 'text', content, ...extra });
function success(content = JSON.stringify(answer), extra = '') {
  return extra + event('conversation.message.completed', message(content))
    + event('conversation.chat.completed', { status: 'completed', last_error: null }) + 'event: done\ndata: [DONE]\n\n';
}
function stream(text, chunkSize = 512, contentType = 'text/event-stream') {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'content-type': contentType } });
}

test('扣子：缺少任一配置时不接入，不调用外部服务', () => {
  for (const config of [{}, { token: 'token' }, { botId: '123' }, { token: ' ', botId: '123' }]) {
    assert.equal(provider({ fetchImpl() { assert.fail('配置不完整不能发请求'); } }, config), undefined);
  }
});

test('扣子：只在后端发送令牌和公开目录，传历史消息并使用隔离用户标识', async () => {
  const requests = [];
  const call = provider({ async fetchImpl(url, options) { requests.push({ url, options }); return stream(success()); } });
  const history = { ...input, messages: [{ role: 'user', content: '找化学工具' },
    { role: 'assistant', content: '要预习还是复习？' }, ...input.messages] };
  const before = structuredClone(history);
  assert.deepEqual(await call(history), answer);
  await call(history);
  assert.equal(requests[0].url, 'https://api.coze.cn/v3/chat');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer unit-test-token');
  assert.equal(requests[0].options.method, 'POST');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.bot_id, '123456');
  assert.equal(body.stream, true);
  assert.equal(body.auto_save_history, false);
  assert.notEqual(body.user_id, JSON.parse(requests[1].options.body).user_id);
  assert.deepEqual(body.additional_messages.slice(0, 2), [
    { role: 'user', content: '找化学工具', content_type: 'text' },
    { role: 'assistant', type: 'answer', content: '要预习还是复习？', content_type: 'text' }
  ]);
  const context = body.additional_messages.at(-1).content;
  for (const text of ['case_a', '不清楚操作顺序', '先描述实验', '适用对象', '找实验预习智能体']) assert.ok(context.includes(text), text);
  assert.ok(!context.includes('不应发送') && !context.includes('unit-test-token') && !context.includes('/real-link'));
  assert.deepEqual(history, before, '不修改调用方的目录或历史');
});

test('扣子：UTF-8 被分割、CRLF、末尾未换行时正确读取最终文本回答', async () => {
  const text = success().replaceAll('\n', '\r\n').trimEnd();
  assert.deepEqual(await provider({ async fetchImpl() { return stream(text, 1); } })(input), answer);
});

test('扣子：不使用增量、工具、知识召回、卡片或后续问题作为业务结果', async () => {
  const extra = event('conversation.message.delta', message('未完成片段'))
    + ['knowledge', 'tool_output', 'follow_up', 'verbose'].map((type) => event('conversation.message.completed', message('内部内容', { type }))).join('')
    + event('conversation.message.completed', message('卡片内容', { content_type: 'card' }))
    + event('conversation.message.completed', message('中间文本回答'));
  assert.deepEqual(await provider({ async fetchImpl() { return stream(success(JSON.stringify(answer), extra)); } })(input), answer);
});

test('扣子：接受 JSON 代码块，返回值只保留回复与案例 ID', async () => {
  const content = '```json\n' + JSON.stringify({ ...answer, other: '无关', agentUrl: 'https://invented.example' }) + '\n```';
  assert.deepEqual(await provider({ async fetchImpl() { return stream(success(content)); } })(input), answer);
});

test('扣子：拒绝无效 JSON、空回复、超长回复和非字符串案例 ID', async () => {
  for (const content of ['自然语言而非约定 JSON', 'null', '[]', '{}',
    JSON.stringify({ reply: ' ', agentIds: [] }), JSON.stringify({ reply: '字'.repeat(2001), agentIds: [] }),
    JSON.stringify({ reply: '回复', agentIds: [5] })]) {
    await assert.rejects(provider({ async fetchImpl() { return stream(success(content)); } })(input), /coze_invalid_reply/);
  }
});

test('扣子：失败、中断与错误事件即使已有回答也不返回推荐', async () => {
  for (const name of ['conversation.chat.failed', 'conversation.chat.requires_action', 'error']) {
    const text = event('conversation.message.completed', message(JSON.stringify(answer))) + event(name, { code: 4100, msg: 'unit-test-token' });
    await assert.rejects(provider({ async fetchImpl() { return stream(text); } })(input), (error) => {
      assert.ok(!error.message.includes('unit-test-token'));
      return error.message.startsWith('coze_');
    });
  }
});

test('扣子：流提前结束或没有文本回答时拒绝，不把部分答案作为成功', async () => {
  for (const text of [event('conversation.message.completed', message(JSON.stringify(answer))),
    event('conversation.message.delta', message(JSON.stringify(answer))) + event('conversation.chat.completed', { status: 'completed' })]) {
    await assert.rejects(provider({ async fetchImpl() { return stream(text); } })(input), /coze_incomplete_response/);
  }
});

test('扣子：HTTP 与非流式错误不泄漏原始令牌或错误内容', async () => {
  await assert.rejects(provider({ async fetchImpl() { return new Response('unit-test-token', { status: 401 }); } })(input), /coze_http_401/);
  await assert.rejects(provider({ async fetchImpl() { return new Response(JSON.stringify({ code: 4100, msg: 'unit-test-token' }),
    { headers: { 'content-type': 'application/json' } }); } })(input), (error) => {
      assert.ok(!error.message.includes('unit-test-token'));
      return error.message.startsWith('coze_');
  });
  await assert.rejects(provider({ async fetchImpl() { throw new Error('network unit-test-token'); } })(input), /coze_request_failed/);
});

test('扣子：请求超时会取消外部调用并返回安全错误', async () => {
  let signal;
  const call = provider({ timeoutMs: 15, fetchImpl(url, options) {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('unit-test-token')), { once: true }));
  } });
  await assert.rejects(call(input), /coze_timeout/);
  assert.equal(signal.aborted, true);
});

test('扣子：异常大流会停止读取，避免无限积累外部响应', async () => {
  await assert.rejects(provider({ async fetchImpl() { return stream('x'.repeat(1024 * 1024 + 1)); } })(input), /coze_response_too_large/);
});

test('扣子：done 终止后立即取消读取，即使 HTTP 流仍然保持连接', async () => {
  let cancelled = false;
  const call = provider({ timeoutMs: 30, async fetchImpl(url, options) {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(success()));
        options.signal.addEventListener('abort', () => controller.error(new Error('abort')), { once: true });
      },
      cancel() { cancelled = true; }
    }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual(await call(input), answer);
  assert.equal(cancelled, true);
});

test('扣子：done 终止之后的回答不能补足提前结束的流', async () => {
  const text = 'event: done\ndata: [DONE]\n\n' + success();
  await assert.rejects(provider({ async fetchImpl() { return stream(text); } })(input), /coze_incomplete_response/);
});

test('扣子：请求3–5个有依据的推荐，并解析每项匹配参考评分', async () => {
  let request;
  const recommendations = [
    { id: 'case_a', matchScore: 99, matchReason: ' 痛点和课程匹配 ', agentUrl: 'https://invented.example' },
    { id: 'case_b', matchScore: 88, matchReason: '功能场景匹配' },
    { id: 'case_c', matchScore: 76, matchReason: '适用对象匹配' }
  ];
  const result = await provider({ async fetchImpl(url, options) {
    request = JSON.parse(options.body);
    return stream(success(JSON.stringify({ reply: '三个相关案例', recommendations, agentIds: ['forged'] })));
  } })(input);
  assert.deepEqual(result, { reply: '三个相关案例', agentIds: ['case_a', 'case_b', 'case_c'], recommendations: [
    { id: 'case_a', matchScore: 99, matchReason: '痛点和课程匹配' },
    { id: 'case_b', matchScore: 88, matchReason: '功能场景匹配' },
    { id: 'case_c', matchScore: 76, matchReason: '适用对象匹配' }
  ] });
  const context = request.additional_messages.at(-1).content;
  assert.match(context, /3–5/);
  assert.match(context, /参考评分/);
  for (const field of ['matchScore', 'matchReason', '痛点', '学科', '适用对象']) assert.ok(context.includes(field), field);
});

test('扣子：评分必须是0–100整数，匹配依据必须非空且最多300字符', async () => {
  const callWith = (entry) => provider({ async fetchImpl() {
    return stream(success(JSON.stringify({ reply: '推荐案例', recommendations: [entry] })));
  } })(input);
  for (const matchScore of [0, 100]) {
    const result = await callWith({ id: 'case_a', matchScore, matchReason: '依据' });
    assert.equal(result.recommendations[0].matchScore, matchScore);
  }
  for (const matchScore of [-1, 101, 99.5, '99', null, undefined]) {
    await assert.rejects(callWith({ id: 'case_a', matchScore, matchReason: '依据' }), /coze_invalid_reply/);
  }
  for (const matchReason of ['', ' ', null, 1, '字'.repeat(301)]) {
    await assert.rejects(callWith({ id: 'case_a', matchScore: 99, matchReason }), /coze_invalid_reply/);
  }
});

test('扣子：最多5个推荐，不足3个允许如实返回，拒绝重复或无效ID', async () => {
  const callWith = (recommendations) => provider({ async fetchImpl() {
    return stream(success(JSON.stringify({ reply: '按实际案例返回', recommendations })));
  } })(input);
  const make = (count) => Array.from({ length: count }, (_, index) => ({ id: `case_${index}`, matchScore: 90 - index, matchReason: '匹配需求' }));
  for (const count of [0, 1, 2, 3, 5]) assert.equal((await callWith(make(count))).agentIds.length, count);
  for (const entries of [make(6), [null], [{ id: '', matchScore: 99, matchReason: '依据' }],
    [make(1)[0], make(1)[0]]]) await assert.rejects(callWith(entries), /coze_invalid_reply/);
});
