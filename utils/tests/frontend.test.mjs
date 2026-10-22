import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings } from '../../project/frontend/js/card-effect-settings.js';

const source = (name) => readFileSync(new URL(`../../project/frontend/js/${name}.js`, import.meta.url), 'utf8');

function element() {
  const listeners = new Map();
  return {
    value: '', textContent: '', innerHTML: '', hidden: true, disabled: false, dataset: {}, style: {},
    focus() {}, reset() {}, scrollIntoView() {}, appendChild() {},
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, event = {}) { return listeners.get(type)?.({ target: this, preventDefault() {}, ...event }); }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function draftStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

function page(name, overrides = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const document = { getElementById: get, body: { style: {} }, addEventListener() {}, createElement: element };
  const context = createContext({
    document, URL, URLSearchParams, localStorage: draftStorage(),
    window: { setTimeout: (callback) => callback() },
    FormData: class { append() {} },
    consumeAuthNotice: () => ({}), loadSession: async () => ({}), renderSessionChip() {}, toast() {}, mountShaderCard: () => () => {}, mountCardTilt: () => () => {}, DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings,
    ...overrides
  });
  const sessionContext = createContext({ document, URL });
  runInContext(source('session').replace(/\bexport /g, '') + '\nglobalThis.api = { escapeHtml, formatTime, parseTags, resolveAgentLink, renderAgentLink, DEMO_AGENTS };', sessionContext);
  Object.assign(context, sessionContext.api);
  let code = source(name).replace(/^import .*;\r?\n/gm, '');
  code = code.split(name === 'agents' ? '/* ---------------- 启动 ---------------- */' : 'await refreshSession();')[0];
  runInContext(code + '\nglobalThis.api = { state, renderDetailBody, openDetail, closeDetail' +
    (name === 'admin' ? ', uploadCover, resetForm, fillForm, startEdit, submitForm' : ', selectPopularAgents, loadPopularAgents, loadAgents, loadCardEffects, renderCard, renderGrid, bindSearch, bindFilters, bindPagination, renderPagination') + ' };', context);
  if (name === 'admin') runInContext('renderRows = () => {}; loadAgents = async () => {}; loadStats = async () => {};', context);
  if (name === 'admin') runInContext('Object.assign(api, { renderViewCell: typeof renderViewCell === "function" ? renderViewCell : undefined, openViews: typeof openViews === "function" ? openViews : undefined });', context);
  if (name === 'admin') {
    context.api.state.session.user = { ssoUid: 'test-admin', isAdmin: true };
    get('agent-form').reset = () => {
      for (const [id, node] of nodes) {
        if (id.startsWith('field-')) node.value = id === 'field-status' ? 'active' : '';
      }
    };
  }
  return { api: context.api, context, get, document };
}

function sessionApi() {
  const context = createContext({ document: {}, URL });
  runInContext(source('session').replace(/\bexport /g, '') + '\nglobalThis.api = { resolveAgentLink };', context);
  return context.api;
}

function paginationItems(total = 13) {
  return Array.from({ length: total }, (_, index) => ({ id: `page-${index + 1}`, name: `第${index + 1}条案例`,
    updatedAt: total - index, viewStats: { viewCount: index + 1 } }));
}

function paginatedPage(items, overrides = {}) {
  const calls = [];
  const dataFor = (url) => {
    const params = new URL(url, 'http://test').searchParams;
    const offset = Number(params.get('offset') || 0);
    const limit = Number(params.get('limit') || 100);
    return { total: items.length, items: items.slice(offset, offset + limit) };
  };
  const result = page('agents', {
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => dataFor(url) }; },
    fetchJson: async (url) => { calls.push(url); return { ok: true, data: dataFor(url) }; },
    ...overrides
  });
  result.document.createElement = () => ({ ...element(), setAttribute() {} });
  return { ...result, calls };
}

test('查询分页：每页六条，服务端总数与显示范围正确，翻页始终使用全库热门排行', async () => {
  const { api, get, calls } = paginatedPage(paginationItems());
  api.bindPagination();
  await api.loadAgents();
  assert.equal(api.state.page, 1);
  assert.equal(api.state.total, 13);
  assert.equal(api.state.items.length, 6);
  assert.deepEqual(calls, ['/api/agents?limit=6&offset=0', '/api/agents?limit=500&offset=6']);
  assert.match(get('result-meta').innerHTML, /<strong>13<\/strong>/);
  assert.match(get('agents-page-info').textContent, /第 1 \/ 3 页/);
  assert.match(get('agents-page-info').textContent, /显示 1–6 条/);
  assert.equal(get('agents-prev').disabled, true);
  assert.equal(get('agents-next').disabled, false);
  const ranks = [...api.state.popular.keys()];
  assert.deepEqual(ranks, ['page-13', 'page-12', 'page-11']);

  await get('agents-next').dispatch('click');
  assert.equal(api.state.page, 2);
  assert.deepEqual(Array.from(api.state.items, (item) => item.id), ['page-7', 'page-8', 'page-9', 'page-10', 'page-11', 'page-12']);
  assert.match(get('agents-page-info').textContent, /显示 7–12 条/);
  assert.deepEqual(calls.slice(-2), ['/api/agents?limit=6&offset=6', '/api/agents?limit=500&offset=0']);
  assert.deepEqual([...api.state.popular.keys()], ranks);

  await get('agents-next').dispatch('click');
  assert.equal(api.state.items.length, 1);
  assert.equal(api.state.items[0].id, 'page-13');
  assert.match(get('agents-page-info').textContent, /显示 13–13 条/);
  assert.equal(get('agents-next').disabled, true);
  await get('agents-prev').dispatch('click');
  assert.equal(api.state.page, 2);
  assert.equal(get('agents-prev').disabled, false);
});

test('查询分页：搜索、重置、全部筛选及清空筛选均回第一页', async () => {
  const { api, context, get } = page('agents');
  const pages = [];
  context.pages = pages;
  runInContext('loadAgents = async () => { pages.push(state.page); };', context);
  api.bindSearch();
  api.bindFilters();
  for (const [id, event, value] of [
    ['search-form', 'submit', '查询词'], ['search-reset', 'click', ''],
    ['filter-discipline', 'change', '工学'], ['filter-school', 'change', '示例大学'],
    ['filter-status', 'change', 'active'], ['filter-clear', 'click', '']
  ]) {
    api.state.page = 3;
    if (id === 'search-form') get('search-input').value = value;
    else get(id).value = value;
    await get(id).dispatch(event);
    assert.equal(api.state.page, 1, id);
  }
  assert.deepEqual(pages, [1, 1, 1, 1, 1, 1]);
});

test('查询分页：筛选首批仅决定匹配总数，不能复用为全库热门数据', async () => {
  const items = paginationItems();
  const { api, get, calls } = paginatedPage(items, { fetch: async (url) => {
    const params = new URL(url, 'http://test').searchParams;
    assert.equal(params.get('q'), '课程');
    assert.equal(params.get('discipline'), '工学');
    assert.equal(params.get('limit'), '6');
    assert.equal(params.get('offset'), '0');
    return { ok: true, json: async () => ({ total: 2, items: items.slice(0, 2) }) };
  } });
  api.state.query = '课程';
  api.state.discipline = '工学';
  await api.loadAgents();
  assert.equal(api.state.total, 2);
  assert.match(get('result-meta').innerHTML, /匹配到 <strong>2<\/strong>/);
  assert.deepEqual([...api.state.popular.keys()], ['page-13', 'page-12', 'page-11']);
  assert.deepEqual(calls, ['/api/agents?limit=500&offset=0']);
});

test('查询分页：请求期间双按钮禁用，重复点击不发新请求', async () => {
  const pending = deferred();
  let requests = 0;
  const items = paginationItems();
  const { api, get } = paginatedPage(items, {
    fetch: () => { requests += 1; return pending.promise; }
  });
  api.state.total = 13;
  api.bindPagination();
  const load = get('agents-next').dispatch('click');
  assert.equal(api.state.page, 2);
  assert.equal(api.state.loading, true);
  assert.equal(get('agents-prev').disabled, true);
  assert.equal(get('agents-next').disabled, true);
  get('agents-next').dispatch('click');
  get('agents-prev').dispatch('click');
  assert.equal(requests, 1);
  pending.resolve({ ok: true, json: async () => ({ total: 13, items: items.slice(6, 12) }) });
  await load;
  assert.equal(api.state.loading, false);
  assert.equal(get('agents-prev').disabled, false);
  assert.equal(get('agents-next').disabled, false);
});

test('查询分页：列表缩减时回合法末页并重新取数据，空结果隐藏分页', async () => {
  const items = paginationItems(7);
  const { api, get, calls } = paginatedPage(items);
  api.state.page = 3;
  await api.loadAgents();
  assert.equal(api.state.page, 2);
  assert.equal(api.state.total, 7);
  assert.equal(api.state.items[0].id, 'page-7');
  assert.deepEqual(calls.slice(0, 2), ['/api/agents?limit=6&offset=12', '/api/agents?limit=6&offset=6']);
  assert.match(get('agents-page-info').textContent, /第 2 \/ 2 页/);
  assert.equal(get('agents-next').disabled, true);
  const empty = paginatedPage([]);
  await empty.api.loadAgents();
  assert.equal(empty.api.state.total, 0);
  assert.equal(empty.get('agent-pagination').hidden, true);
});

test('查询分页：旧页慢响应不覆盖新页、真实总数或全局排行', async () => {
  const pending = [deferred(), deferred()];
  let index = 0;
  const items = paginationItems(12);
  const { api, get, calls } = paginatedPage(items, { fetch: () => pending[index++].promise });
  const first = api.loadAgents();
  api.state.page = 2;
  const second = api.loadAgents();
  pending[1].resolve({ ok: true, json: async () => ({ total: 12, items: items.slice(6) }) });
  await second;
  pending[0].resolve({ ok: true, json: async () => ({ total: 99, items: [{ id: 'stale', name: '旧案例', viewStats: { viewCount: 999 } }] }) });
  await first;
  assert.equal(api.state.page, 2);
  assert.equal(api.state.total, 12);
  assert.equal(api.state.items[0].id, 'page-7');
  assert.equal(api.state.popular.has('stale'), false);
  assert.deepEqual(calls, ['/api/agents?limit=500&offset=0']);
  assert.match(get('agents-page-info').textContent, /第 2 \/ 2 页/);
  assert.equal(api.state.loading, false);
});

test('查询分页：离线示例按六条切页，超页自动夹紧，搜索后回首屏并更新总数', async () => {
  const { api, context, get } = paginatedPage([], { fetch: async () => { throw new Error('offline'); } });
  context.DEMO_AGENTS = paginationItems();
  api.bindSearch();
  api.state.page = 2;
  await api.loadAgents();
  assert.equal(api.state.usingDemo, true);
  assert.equal(api.state.items[0].id, 'page-7');
  assert.equal(api.state.items.length, 6);
  assert.equal(api.state.total, 13);
  assert.equal(api.state.popular.size, 0);
  assert.match(get('result-meta').innerHTML, /<strong>13<\/strong>/);
  api.state.page = 5;
  await api.loadAgents();
  assert.equal(api.state.page, 3);
  assert.equal(api.state.items.length, 1);
  get('search-input').value = '第13条';
  await get('search-form').dispatch('submit');
  assert.equal(api.state.page, 1);
  assert.equal(api.state.total, 1);
  assert.equal(api.state.items[0].id, 'page-13');
  assert.equal(get('agents-next').disabled, true);
});

test('聊天推荐详情：当前页不含推荐 ID 时仍读取真实详情，失败重试保留推荐入口', async () => {
  let requests = 0;
  const { api, get } = page('agents', { fetchJson: async (url) => {
    assert.equal(url, '/api/agents/off-page');
    requests += 1;
    return requests === 1 ? { ok: false, status: 503 } : { ok: true, data: { item: { id: 'off-page', name: '真实推荐案例', painPoint: '真实详情' } } };
  } });
  api.state.items = [{ id: 'on-page', name: '当前页案例' }];
  const suggested = { id: 'off-page', name: '推荐案例', painPoint: '推荐临时内容' };
  await api.openDetail('off-page', suggested);
  assert.equal(get('detail-backdrop').hidden, false);
  assert.match(get('detail-body').innerHTML, /详情未加载/);
  assert.doesNotMatch(get('detail-body').innerHTML, /推荐临时内容/);
  await get('detail-retry').dispatch('click');
  assert.equal(requests, 2);
  assert.match(get('detail-body').innerHTML, /真实详情/);
  api.state.usingDemo = true;
  api.closeDetail();
  await api.openDetail('off-page', suggested);
  assert.equal(get('detail-backdrop').hidden, true, '离线示例不可用推荐数据模拟跨页真实详情');
});

test('查询卡片：只展示专业与学校、不展示标签；详情仍包含学科课程和标签', () => {
  const { api, document } = page('agents');
  document.createElement = () => ({ ...element(), setAttribute() {} });
  const agent = { id: 'compact', name: '案例名称', summary: '案例简介', major: '保留专业', schoolName: '保留大学',
    discipline: '详情学科', courseName: '详情课程', tags: '详情标签', status: 'active' };
  const card = api.renderCard(agent);
  assert.match(card.innerHTML, /保留专业/);
  assert.match(card.innerHTML, /保留大学/);
  assert.doesNotMatch(card.innerHTML, /详情学科|详情课程|详情标签|tag-row/);
  const detail = api.renderDetailBody(agent);
  assert.match(detail, /保留专业/);
  assert.match(detail, /保留大学/);
  assert.match(detail, /详情学科/);
  assert.match(detail, /详情课程/);
  assert.match(detail, /详情标签/);
});

test('查询页效果：读取全站三色参数，挂载所有摆动和热门画布时使用同一配置', async () => {
  const mounts = [];
  const settings = { ...DEFAULT_CARD_EFFECT_SETTINGS, flame1: '#102030', flame2: '#405060', flame3: '#708090', opacity: 0.8, tilt: 4 };
  const { api, document } = page('agents', {
    fetchJson: async (url) => { assert.equal(url, '/api/card-effects'); return { ok: true, data: { settings } }; },
    mountCardTilt: (_card, values) => { assert.equal(values.tilt, 4); return () => {}; },
    mountShaderCard: (_card, values, rank) => { mounts.push({ values, rank }); return () => {}; }
  });
  await api.loadCardEffects();
  document.createElement = () => ({ ...element(), setAttribute() {} });
  api.state.items = ['a', 'b', 'c'].map((id, index) => ({ id, name: id, viewStats: { viewCount: 3 - index } }));
  api.state.popular = api.selectPopularAgents(api.state.items);
  api.renderGrid();
  assert.deepEqual(mounts.map(({ rank }) => rank), [1, 2, 3]);
  for (const { values } of mounts) assert.deepEqual(values, settings);
});

test('查询页效果：读取失败或异常参数时保留可用的默认效果', async () => {
  for (const fetchJson of [async () => { throw new Error('offline'); }, async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, data: { settings: { flame1: 'bad', opacity: NaN } } })]) {
    const { api } = page('agents', { fetchJson });
    await api.loadCardEffects();
    assert.deepEqual({ ...api.state.cardEffects }, DEFAULT_CARD_EFFECT_SETTINGS);
  }
});

test('热门排行：按全库真实浏览次数取前三，平局按更新时间和 ID，保留零次', () => {
  const { api } = page('agents');
  const items = [
    { id: 'older', updatedAt: 1, viewStats: { viewCount: 10 } },
    { id: 'b', updatedAt: 2, viewStats: { viewCount: 10 } },
    { id: 'a', updatedAt: 2, viewStats: { viewCount: 10 } },
    { id: 'most', updatedAt: 0, viewStats: { viewCount: 11 } },
    { id: 'unknown', updatedAt: 9 },
    { id: 'invalid', viewStats: { viewCount: -1 } }
  ];
  const ranked = api.selectPopularAgents(items);
  assert.deepEqual([...ranked.keys()], ['most', 'a', 'b']);
  assert.equal(ranked.get('most').rank, 1);
  assert.equal(ranked.get('a').viewCount, 10);
  assert.deepEqual(items.map((item) => item.id), ['older', 'b', 'a', 'most', 'unknown', 'invalid']);
  assert.equal(api.selectPopularAgents([{ id: 'zero', viewStats: { viewCount: 0 } }]).get('zero').viewCount, 0);
});

test('热门排行：跨分页读取全库，搜索筛选不改变排名', async () => {
  const calls = [];
  const { api } = page('agents', { fetchJson: async (url) => {
    calls.push(url);
    return { ok: true, data: calls.length === 1
      ? { total: 3, items: [{ id: 'a', viewStats: { viewCount: 1 } }, { id: 'b', viewStats: { viewCount: 2 } }] }
      : { total: 3, items: [{ id: 'outside-first-page', viewStats: { viewCount: 9 } }] } };
  } });
  api.state.query = '筛选词';
  api.state.discipline = '工学';
  const ranked = await api.loadPopularAgents();
  assert.deepEqual(calls, ['/api/agents?limit=500&offset=0', '/api/agents?limit=500&offset=2']);
  assert.deepEqual([...ranked.keys()], ['outside-first-page', 'b', 'a']);
  assert.equal(ranked.get('outside-first-page').viewCount, 9);
});

test('热门排行：首屏完整数据直接复用，统计失败及离线示例不伪造热门', async () => {
  const { api } = page('agents', { fetchJson: async () => { throw new Error('offline'); } });
  const ranked = await api.loadPopularAgents({ total: 1, items: [{ id: 'real', viewStats: { viewCount: 3 } }] });
  assert.equal(ranked.get('real').rank, 1);
  assert.equal((await api.loadPopularAgents()).size, 0);
  assert.equal(api.selectPopularAgents([{ id: 'demo', name: '演示' }]).size, 0);
});

test('热门排行：迟到的列表及统计不覆盖新查询的案例和排名', async () => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const { api, context } = page('agents', { fetch: () => requests[index++].promise });
  runInContext('renderGrid = () => {}; renderMeta = () => {}; renderFilterCount = () => {};', context);
  const first = api.loadAgents();
  const second = api.loadAgents();
  requests[1].resolve({ ok: true, json: async () => ({ total: 1, items: [{ id: 'new', viewStats: { viewCount: 7 } }] }) });
  await second;
  requests[0].resolve({ ok: true, json: async () => ({ total: 1, items: [{ id: 'old', viewStats: { viewCount: 99 } }] }) });
  await first;
  assert.equal(api.state.items[0].id, 'new');
  assert.equal(api.state.popular.get('new').viewCount, 7);
  assert.equal(api.state.popular.has('old'), false);
});

test('卡片摆动：所有卡片挂载鼠标交互，仅热门前三绘制流体，筛选重绘释放旧交互', () => {
  const tilted = [];
  const shaders = [];
  let tiltDisposed = 0;
  let shaderDisposed = 0;
  const { api, document } = page('agents', {
    mountCardTilt: (card) => { tilted.push(card.dataset.agentId); return () => { tiltDisposed++; }; },
    mountShaderCard: (card, settings, rank) => { shaders.push([card.dataset.agentId, rank]); assert.equal(settings.flame2, '#ff4a17'); return () => { shaderDisposed++; }; }
  });
  document.createElement = () => ({ ...element(), setAttribute() {} });
  api.state.items = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, name: id, viewStats: { viewCount: 4 - index } }));
  api.state.popular = api.selectPopularAgents(api.state.items);
  api.renderGrid();
  assert.deepEqual(tilted, ['a', 'b', 'c', 'd']);
  assert.deepEqual(shaders, [['a', 1], ['b', 2], ['c', 3]]);
  api.state.items = [api.state.items[3]];
  api.renderGrid();
  assert.equal(tiltDisposed, 4);
  assert.equal(shaderDisposed, 3);
  assert.equal(tilted.length, 5);
  assert.equal(shaders.length, 3);
});

test('前台链接：拒绝不可解析 URL、反斜杠与控制字符，保留合法链接', () => {
  const { resolveAgentLink } = sessionApi();
  for (const value of ['https://', 'https://#', 'http:// bad', '/\\evil.example/x', '/\t/evil.example', '\nhttps://example.com']) {
    assert.equal(resolveAgentLink(value), null, `${JSON.stringify(value)} 不得成为可点击链接`);
  }
  assert.equal(resolveAgentLink(' /agents.html?q=1 ').href, '/agents.html?q=1');
  assert.equal(resolveAgentLink('https://example.com/agent').href, 'https://example.com/agent');
});

for (const name of ['agents', 'admin']) {
  test(`${name}：扩展字段显示 null、false、0 与嵌套对象`, () => {
    const { api } = page(name);
    const html = api.renderDetailBody({ name: '测试', data: { 空值: null, 布尔: false, 数字: 0, 嵌套: { 项: ['值'] } } });
    assert.match(html, /<div class="kv-value">null<\/div>/);
    assert.match(html, /<div class="kv-value">false<\/div>/);
    assert.match(html, /<div class="kv-value">0<\/div>/);
    assert.match(html, /&quot;项&quot;/);
  });
}

test('前台详情：同名不同 ID 的慢响应不会覆盖当前记录', async () => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const { api, get } = page('agents', { fetchJson: () => requests[index++].promise });
  api.state.items = [{ id: 'a', name: '同名' }, { id: 'b', name: '同名' }];
  const first = api.openDetail('a');
  const second = api.openDetail('b');
  requests[1].resolve({ ok: true, data: { item: { id: 'b', name: '同名', painPoint: '第二条内容' } } });
  await second;
  requests[0].resolve({ ok: true, data: { item: { id: 'a', name: '同名', painPoint: '第一条内容' } } });
  await first;
  assert.match(get('detail-body').innerHTML, /第二条内容/);
  assert.doesNotMatch(get('detail-body').innerHTML, /第一条内容/);
});

test('前台详情：关闭后重开同一 ID，旧请求不能覆盖新请求', async () => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const { api, get } = page('agents', { fetchJson: () => requests[index++].promise });
  api.state.items = [{ id: 'a', name: '案例' }];
  const first = api.openDetail('a');
  api.closeDetail();
  const second = api.openDetail('a');
  requests[1].resolve({ ok: true, data: { item: { id: 'a', name: '案例', usageGuide: '新说明' } } });
  await second;
  requests[0].resolve({ ok: true, data: { item: { id: 'a', name: '案例', usageGuide: '旧说明' } } });
  await first;
  assert.match(get('detail-body').innerHTML, /新说明/);
  assert.doesNotMatch(get('detail-body').innerHTML, /旧说明/);
});

test('前台详情：失败明确提示并可重试，不把长字段误报为空', async () => {
  let calls = 0;
  const { api, get } = page('agents', { fetchJson: async () => ++calls === 1
    ? { ok: false, status: 500 }
    : { ok: true, data: { item: { id: 'a', name: '案例', painPoint: '已保存痛点', data: { 空值: null } } } } });
  api.state.items = [{ id: 'a', name: '案例', summary: '已保存简介' }];
  await api.openDetail('a');
  assert.match(get('detail-body').innerHTML, /详情未加载/);
  assert.doesNotMatch(get('detail-body').innerHTML, /暂无描述|暂无说明|该记录暂无扩展字段/);
  await get('detail-retry').dispatch('click');
  assert.equal(calls, 2);
  assert.match(get('detail-body').innerHTML, /已保存痛点/);
});

const image = { type: 'image/png', size: 128, name: 'cover.png' };
const uploaded = (url) => ({ ok: true, status: 201, json: async () => ({ url }) });

test('浏览统计：成功展示详情才记录，记录失败不影响详情', async () => {
  const calls = [];
  const { api, get } = page('agents', { fetchJson: async (url, options) => {
    calls.push({ url, method: options?.method || 'GET' });
    if (options?.method === 'POST') throw new Error('offline');
    return { ok: true, data: { item: { id: 'a', name: '案例', painPoint: '完整详情' } } };
  } });
  api.state.session.backendReady = true;
  api.state.items = [{ id: 'a', name: '案例' }];
  await api.openDetail('a');
  assert.deepEqual(calls, [{ url: '/api/agents/a', method: 'GET' }, { url: '/api/agents/a/views', method: 'POST' }]);
  assert.match(get('detail-body').innerHTML, /完整详情/);
});

test('浏览统计：加载失败、关闭后的迟到详情不记录', async () => {
  const request = deferred();
  const calls = [];
  const { api } = page('agents', { fetchJson: (url, options) => {
    calls.push(options?.method || 'GET');
    return request.promise;
  } });
  api.state.session.backendReady = true;
  api.state.items = [{ id: 'a', name: '案例' }];
  const opening = api.openDetail('a');
  api.closeDetail();
  request.resolve({ ok: true, data: { item: { id: 'a', name: '案例' } } });
  await opening;
  assert.deepEqual(calls, ['GET']);
  const failedCalls = [];
  const failed = page('agents', { fetchJson: async (url, options) => {
    failedCalls.push(options?.method || 'GET');
    return { ok: false };
  } });
  failed.api.state.session.backendReady = true;
  failed.api.state.items = [{ id: 'a', name: '案例' }];
  await failed.api.openDetail('a');
  assert.deepEqual(failedCalls, ['GET']);
});

test('浏览统计：管理员查看和离线演示不记录', async () => {
  const calls = [];
  const { api } = page('agents', { fetchJson: async (url, options) => {
    calls.push(options?.method || 'GET');
    return { ok: true, data: { item: { id: 'a', name: '案例' } } };
  } });
  api.state.session = { backendReady: true, user: { isAdmin: true } };
  api.state.items = [{ id: 'a', name: '案例' }];
  await api.openDetail('a');
  api.state.usingDemo = true;
  await api.openDetail('a');
  assert.deepEqual(calls, ['GET']);
});

test('浏览统计：登录人数与匿名访客分开显示，缺统计不伪装为零', () => {
  const { api } = page('admin');
  assert.equal(typeof api.renderViewCell, 'function');
  const html = api.renderViewCell({ name: '<案例>', viewStats: { userCount: 2, anonymousCount: 3, viewCount: 8 } });
  assert.match(html, /2 人/);
  assert.match(html, /匿名访客 3/);
  assert.match(html, /8 次/);
  assert.doesNotMatch(html, /<案例>/);
  assert.match(api.renderViewCell({ name: '旧服务' }), /—/);
});

test('浏览明细：加载访客、分页、姓名转义，不泄漏标识', async () => {
  const calls = [];
  const { api, get } = page('admin', { fetchJson: async (url) => {
    calls.push(url);
    return { ok: true, data: { viewStats: { userCount: 1, anonymousCount: 1, viewCount: 4 }, total: 21,
      items: [{ visitorType: 'user', displayName: '<学生>', viewCount: 3, firstViewedAt: 1, lastViewedAt: 2 },
        { visitorType: 'anonymous', displayName: '匿名访客', viewCount: 1, firstViewedAt: 2, lastViewedAt: 2 }] } };
  } });
  assert.equal(typeof api.openViews, 'function');
  api.state.items = [{ id: 'a', name: '案例' }];
  await api.openViews('a');
  assert.equal(calls[0], '/api/agents/a/views?limit=20&offset=0');
  assert.match(get('detail-body').innerHTML, /&lt;学生&gt;/);
  assert.match(get('detail-body').innerHTML, /匿名访客|首次浏览|最近浏览/);
  await get('views-next').dispatch('click');
  assert.equal(calls[1], '/api/agents/a/views?limit=20&offset=20');
});

test('浏览明细：失败提供重试，成功的零记录显示空态', async () => {
  let calls = 0;
  const { api, get } = page('admin', { fetchJson: async () => ++calls === 1
    ? { ok: false, status: 500 }
    : { ok: true, data: { viewStats: { userCount: 0, anonymousCount: 0, viewCount: 0 }, total: 0, items: [] } } });
  assert.equal(typeof api.openViews, 'function');
  api.state.items = [{ id: 'a', name: '案例' }];
  await api.openViews('a');
  assert.match(get('detail-body').innerHTML, /加载失败/);
  await get('views-retry').dispatch('click');
  assert.match(get('detail-body').innerHTML, /暂无浏览记录/);
});

test('浏览明细：切换记录、关闭后迟到响应不覆盖当前弹窗', async () => {
  const requests = [deferred(), deferred(), deferred()];
  let index = 0;
  const { api, get } = page('admin', { fetchJson: () => requests[index++].promise });
  assert.equal(typeof api.openViews, 'function');
  api.state.items = [{ id: 'a', name: '案例一' }, { id: 'b', name: '案例二' }];
  const first = api.openViews('a');
  const second = api.openViews('b');
  requests[1].resolve({ ok: true, data: { viewStats: {}, total: 1, items: [{ displayName: '当前访客' }] } });
  await second;
  requests[0].resolve({ ok: true, data: { viewStats: {}, total: 1, items: [{ displayName: '旧访客' }] } });
  await first;
  assert.match(get('detail-body').innerHTML, /当前访客/);
  assert.doesNotMatch(get('detail-body').innerHTML, /旧访客/);
  const third = api.openViews('a');
  api.closeDetail();
  const closed = get('detail-body').innerHTML;
  requests[2].resolve({ ok: true, data: { viewStats: {}, total: 0, items: [] } });
  await third;
  assert.equal(get('detail-body').innerHTML, closed);
});

test('上传中：禁用并阻止提交，上传成功后可提交封面 URL', async () => {
  const request = deferred();
  const writes = [];
  const { api, get } = page('admin', { fetch: () => request.promise, fetchJson: async (url, options) => {
    writes.push(JSON.parse(options.body));
    return { ok: true, data: { item: JSON.parse(options.body) } };
  } });
  get('field-name').value = '案例';
  const pending = api.uploadCover(image);
  const disabledDuringUpload = get('form-submit').disabled;
  await api.submitForm({ preventDefault() {} });
  const writesDuringUpload = writes.length;
  request.resolve(uploaded('/uploads/new.png'));
  await pending;
  assert.equal(disabledDuringUpload, true);
  assert.equal(writesDuringUpload, 0);
  assert.equal(get('form-submit').disabled, false);
  await api.submitForm({ preventDefault() {} });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].coverImage, '/uploads/new.png');
});

test('上传：后选图片覆盖先选，过期响应不改变预览与提交按钮', async () => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const { api, get } = page('admin', { fetch: () => requests[index++].promise });
  const first = api.uploadCover(image);
  const second = api.uploadCover({ ...image, name: 'later.png' });
  requests[1].resolve(uploaded('/uploads/later.png'));
  await second;
  requests[0].resolve(uploaded('/uploads/earlier.png'));
  await first;
  assert.equal(get('field-cover').value, '/uploads/later.png');
  assert.match(get('cover-preview').innerHTML, /later.png/);
  assert.equal(get('form-submit').disabled, false);
});

for (const action of ['清空', '取消编辑', '编辑切换', '清除封面']) {
  test(`上传：${action}后过期响应不会回填旧表单`, async () => {
    const request = deferred();
    const { api, get } = page('admin', { fetch: () => request.promise, fetchJson: async () => ({ ok: true, data: { item: { id: 'b', name: '新记录', coverImage: '/uploads/b.png' } } }) });
    const pending = api.uploadCover(image);
    if (action === '清空') get('form-reset').dispatch('click');
    else if (action === '取消编辑') get('form-cancel').dispatch('click');
    else if (action === '编辑切换') await api.startEdit('b');
    else get('cover-clear').dispatch('click');
    request.resolve(uploaded('/uploads/obsolete.png'));
    await pending;
    assert.equal(get('field-cover').value, action === '编辑切换' ? '/uploads/b.png' : '');
    assert.doesNotMatch(get('cover-preview').innerHTML, /obsolete.png/);
    assert.equal(get('form-submit').disabled, false);
    assert.equal(get('cover-status').textContent, '');
  });
}

test('上传：后选非法文件使先选请求失效，失败后提交可恢复', async () => {
  const request = deferred();
  const { api, get } = page('admin', { fetch: () => request.promise });
  const pending = api.uploadCover(image);
  await api.uploadCover({ ...image, type: 'text/html' });
  request.resolve(uploaded('/uploads/obsolete.png'));
  await pending;
  assert.equal(get('field-cover').value, '');
  assert.match(get('create-notice').textContent, /不支持/);
  assert.equal(get('form-submit').disabled, false);
});

test('上传：过期响应不能提前解锁正在上传的后选图片', async () => {
  const requests = [deferred(), deferred()];
  let index = 0;
  const { api, get } = page('admin', { fetch: () => requests[index++].promise });
  const first = api.uploadCover(image);
  const second = api.uploadCover({ ...image, name: 'later.png' });
  requests[0].resolve(uploaded('/uploads/earlier.png'));
  await first;
  assert.equal(get('form-submit').disabled, true);
  assert.equal(get('field-cover').value, '');
  requests[1].resolve(uploaded('/uploads/later.png'));
  await second;
  assert.equal(get('field-cover').value, '/uploads/later.png');
  assert.equal(get('form-submit').disabled, false);
});

for (const failure of ['HTTP', '网络']) {
  test(`上传：${failure}失败显示提示并恢复提交，保留既有封面`, async () => {
    const { api, get } = page('admin', { fetch: async () => {
      if (failure === '网络') throw new Error('network');
      return { ok: false, status: 413, json: async () => ({ error: 'file_too_large' }) };
    } });
    api.fillForm({ name: '案例', coverImage: '/uploads/existing.png' });
    await api.uploadCover(image);
    assert.equal(get('form-submit').disabled, false);
    assert.equal(get('field-cover').value, '/uploads/existing.png');
    assert.match(get('cover-preview').innerHTML, /existing.png/);
    assert.equal(get('cover-status').textContent, '上传失败');
    assert.equal(get('create-notice').dataset.tone, 'error');
  });
}

test('正在提交：不启动新上传，提交完成后不回填迟到封面', async () => {
  const save = deferred();
  let uploads = 0;
  const { api, get } = page('admin', { fetchJson: () => save.promise, fetch: async () => {
    uploads++;
    return uploaded('/uploads/late.png');
  } });
  get('field-name').value = '案例';
  const pending = api.submitForm({ preventDefault() {} });
  await api.uploadCover(image);
  save.resolve({ ok: true, data: { item: { name: '案例' } } });
  await pending;
  assert.equal(uploads, 0);
  assert.equal(get('field-cover').value, '');
  assert.equal(get('form-submit').disabled, false);
});

test('管理端表单：新增按钮打开弹窗并切换为新增模式', () => {
  const { api, get, document } = page('admin');
  api.state.editingId = 'old';
  get('agent-create').dispatch('click');
  assert.equal(get('form-backdrop').hidden, false);
  assert.equal(api.state.editingId, null);
  assert.equal(get('form-title').textContent, '新增智能体');
  assert.equal(document.body.style.overflow, 'hidden');
});

test('管理端表单：编辑在弹窗中回填案例字段', async () => {
  const { api, get } = page('admin', { fetchJson: async () => ({ ok: true, data: {
    item: { id: 'a', name: '现有案例', painPoint: '已保存痛点', coverImage: '/uploads/a.png' }
  } }) });
  await api.startEdit('a');
  assert.equal(get('form-backdrop').hidden, false);
  assert.equal(api.state.editingId, 'a');
  assert.equal(get('field-name').value, '现有案例');
  assert.equal(get('field-pain').value, '已保存痛点');
  assert.equal(get('field-cover').value, '/uploads/a.png');
});

test('管理端表单：关闭弹窗使迟到的上传响应失效', async () => {
  const request = deferred();
  const { api, get, document } = page('admin', { fetch: () => request.promise });
  get('agent-create').dispatch('click');
  const pending = api.uploadCover(image);
  get('form-close').dispatch('click');
  request.resolve(uploaded('/uploads/obsolete.png'));
  await pending;
  assert.equal(get('form-backdrop').hidden, true);
  assert.equal(document.body.style.overflow, '');
  assert.equal(get('field-cover').value, '');
  assert.doesNotMatch(get('cover-preview').innerHTML, /obsolete.png/);
});

test('管理端表单：取消后迟到的编辑响应不会重新打开弹窗', async () => {
  const request = deferred();
  const { api, get } = page('admin', { fetchJson: () => request.promise });
  get('agent-create').dispatch('click');
  const pending = api.startEdit('a');
  get('form-close').dispatch('click');
  request.resolve({ ok: true, data: { item: { id: 'a', name: '迟到案例' } } });
  await pending;
  assert.equal(get('form-backdrop').hidden, true);
  assert.equal(api.state.editingId, null);
});

test('管理端表单：新增成功关闭弹窗，使用原有新增接口', async () => {
  const writes = [];
  const { api, get } = page('admin', { fetchJson: async (url, options) => {
    writes.push({ url, method: options.method });
    return { ok: true, data: { item: JSON.parse(options.body) } };
  } });
  get('agent-create').dispatch('click');
  assert.equal(get('form-backdrop').hidden, false);
  get('field-name').value = '新案例';
  await api.submitForm({ preventDefault() {} });
  assert.deepEqual(writes, [{ url: '/api/agents', method: 'POST' }]);
  assert.equal(get('form-backdrop').hidden, true);
});

test('管理端表单：提交失败保留弹窗和已填写内容', async () => {
  const { api, get } = page('admin', { fetchJson: async () => ({ ok: false, status: 500 }) });
  get('agent-create').dispatch('click');
  get('field-name').value = '待保存案例';
  await api.submitForm({ preventDefault() {} });
  assert.equal(get('form-backdrop').hidden, false);
  assert.equal(get('field-name').value, '待保存案例');
  assert.match(get('create-notice').textContent, /写入失败/);
});

test('管理端表单：保存期间不关闭，完成后恢复关闭操作', async () => {
  const save = deferred();
  const { api, get } = page('admin', { fetchJson: () => save.promise });
  get('agent-create').dispatch('click');
  get('field-name').value = '案例';
  const pending = api.submitForm({ preventDefault() {} });
  get('form-close').dispatch('click');
  assert.equal(get('form-backdrop').hidden, false);
  save.resolve({ ok: false, status: 500 });
  await pending;
  get('form-close').dispatch('click');
  assert.equal(get('form-backdrop').hidden, true);
});

test('新增弹窗：点击遮罩不关闭，不清空输入', () => {
  const { get } = page('admin');
  get('agent-create').dispatch('click');
  get('field-name').value = '未完成案例';
  get('form-backdrop').dispatch('click');
  assert.equal(get('form-backdrop').hidden, false);
  assert.equal(get('field-name').value, '未完成案例');
});

test('新增草稿：暂存不校验必填或 JSON，刷新后恢复原始文字与已上传封面', () => {
  const storage = draftStorage();
  const first = page('admin', { localStorage: storage });
  first.get('agent-create').dispatch('click');
  first.get('field-summary').value = '  尚未填写名称\n继续完善  ';
  first.get('field-data').value = '{尚未写完';
  first.get('field-cover').value = '/uploads/draft.png';
  first.get('form-draft').dispatch('click');
  assert.match(first.get('create-notice').textContent, /已暂存/);
  assert.equal(first.get('form-backdrop').hidden, false);
  const refreshed = page('admin', { localStorage: storage });
  refreshed.get('agent-create').dispatch('click');
  assert.equal(refreshed.get('field-summary').value, '  尚未填写名称\n继续完善  ');
  assert.equal(refreshed.get('field-data').value, '{尚未写完');
  assert.equal(refreshed.get('field-cover').value, '/uploads/draft.png');
  assert.match(refreshed.get('cover-preview').innerHTML, /draft.png/);
});

test('新增草稿：主动关闭后重新打开恢复输入', () => {
  const { get } = page('admin');
  get('agent-create').dispatch('click');
  get('field-name').value = '继续填写的案例';
  get('form-close').dispatch('click');
  assert.equal(get('form-backdrop').hidden, true);
  get('agent-create').dispatch('click');
  assert.equal(get('field-name').value, '继续填写的案例');
});

test('新增草稿：清空表单同时清除暂存内容', () => {
  const { get } = page('admin');
  get('agent-create').dispatch('click');
  get('field-name').value = '要清空的草稿';
  get('form-draft').dispatch('click');
  get('form-reset').dispatch('click');
  get('agent-create').dispatch('click');
  assert.equal(get('field-name').value, '');
});

test('新增草稿：正式新增成功后不恢复已经提交的草稿', async () => {
  const { api, get } = page('admin', { fetchJson: async (_url, options) => ({
    ok: true, data: { item: JSON.parse(options.body) }
  }) });
  get('agent-create').dispatch('click');
  get('field-name').value = '已提交案例';
  get('form-draft').dispatch('click');
  await api.submitForm({ preventDefault() {} });
  get('agent-create').dispatch('click');
  assert.equal(get('field-name').value, '');
});

test('新增草稿：账号互相隔离，编辑和还原原值不覆盖新增草稿', async () => {
  const storage = draftStorage();
  const first = page('admin', { localStorage: storage, fetchJson: async () => ({
    ok: true, data: { item: { id: 'a', name: '编辑案例' } }
  }) });
  first.get('agent-create').dispatch('click');
  first.get('field-name').value = '管理员一的新增草稿';
  first.get('form-draft').dispatch('click');
  await first.api.startEdit('a');
  assert.equal(first.get('form-draft').hidden, true);
  first.get('form-reset').dispatch('click');
  first.get('form-cancel').dispatch('click');
  first.get('agent-create').dispatch('click');
  assert.equal(first.get('field-name').value, '管理员一的新增草稿');
  const other = page('admin', { localStorage: storage });
  other.api.state.session.user.ssoUid = 'other-admin';
  other.get('agent-create').dispatch('click');
  assert.equal(other.get('field-name').value, '');
});

test('新增草稿：浏览器存储失败提示错误，关闭时保留当前输入', () => {
  const { get } = page('admin', { localStorage: { getItem: () => null,
    setItem: () => { throw new Error('quota'); }, removeItem() {} } });
  get('agent-create').dispatch('click');
  get('field-name').value = '不能丢失的内容';
  get('form-draft').dispatch('click');
  assert.equal(get('create-notice').dataset.tone, 'error');
  get('form-close').dispatch('click');
  assert.equal(get('form-backdrop').hidden, false);
  assert.equal(get('field-name').value, '不能丢失的内容');
});

test('新增草稿：手动暂存等待上传完成后保存最终封面地址', async () => {
  const storage = draftStorage();
  const upload = deferred();
  const { api, get } = page('admin', { localStorage: storage, fetch: () => upload.promise });
  get('agent-create').dispatch('click');
  const pending = api.uploadCover(image);
  get('form-draft').dispatch('click');
  assert.match(get('create-notice').textContent, /上传/);
  upload.resolve(uploaded('/uploads/final.png'));
  await pending;
  get('form-draft').dispatch('click');
  const refreshed = page('admin', { localStorage: storage });
  refreshed.get('agent-create').dispatch('click');
  assert.equal(refreshed.get('field-cover').value, '/uploads/final.png');
});
