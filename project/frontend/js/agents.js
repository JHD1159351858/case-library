/**
 * 智能体查询平台页逻辑
 *
 * 数据流：
 *   1. 首屏调 /api/agents 拉取列表（后端不可用则回退内置演示数据并显著提示）
 *   2. 搜索 / 筛选（学科 / 学校 / 状态）→ 服务端过滤（?q=&discipline=&school=&status=）
 *   3. 筛选下拉选项来自 /api/agents/stats（取现有数据中的学科与学校）
 *   4. 点击卡片 → 弹窗展示完整明细（痛点 / 使用说明 / 扩展字段键值对）
 *
 * 说明：本页「查询」对所有访客开放；「新增 / 编辑 / 删除」在管理端（admin.html）。
 */
import { consumeAuthNotice, DEMO_AGENTS, escapeHtml, fetchJson, formatTime, loadSession, parseTags, renderAgentLink, renderSessionChip, resolveAgentLink, toast } from './session.js';
import { mountCardTilt, mountShaderCard } from './shader-card.js';
import { DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings } from './card-effect-settings.js';
import { initAgentChat } from './agent-chat.js';

const $ = (id) => document.getElementById(id);

/** 外链图标（提示「新标签打开」） */
const EXTERNAL_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h-3v9h9v-3" /><path d="M9.5 3.5h3v3" /><path d="M12.5 3.5 7.5 8.5" /></svg>';

const state = {
  session: { user: null, ssoEnabled: false, backendReady: false },
  items: [],
  page: 1,
  pageSize: 6,
  total: 0,
  loading: false,
  query: '',
  discipline: '',
  school: '',
  status: '',
  usingDemo: false,
  popular: new Map(),
  featuredAgents: null,
  cardEffects: { ...DEFAULT_CARD_EFFECT_SETTINGS },
  listRequest: 0,
  detailId: null,
  detailRequest: 0
};
const cardCleanups = [];

async function loadCardEffects() {
  try {
    const { ok, data } = await fetchJson('/api/card-effects');
    if (ok && data?.settings) state.cardEffects = normalizeCardEffectSettings(data.settings);
  } catch {
    // 配置暂不可用时保留默认效果，案例查询继续可用。
  }
}

/* ---------------- 列表渲染 ---------------- */

function renderMeta() {
  const meta = $('result-meta');
  if (!meta) return;
  if (state.usingDemo) {
    meta.innerHTML = `后端服务未连接，当前展示 <strong>${state.total}</strong> 条内置演示数据。请通过 <code>http://127.0.0.1:2001/</code> 访问以查询真实数据。`;
    return;
  }
  const filters = [state.discipline, state.school, state.status === 'inactive' ? '未启用' : state.status === 'active' ? '已启用' : '']
    .filter(Boolean)
    .join(' / ');
  const condition = [state.query ? `关键词 <code>${escapeHtml(state.query)}</code>` : '', filters ? `筛选 <code>${escapeHtml(filters)}</code>` : '']
    .filter(Boolean)
    .join(' + ');

  if (!state.total) {
    meta.innerHTML = condition ? `${condition} 未匹配到记录。` : '暂无智能体记录，可在管理端新增。';
    return;
  }
  meta.innerHTML = condition
    ? `${condition} 匹配到 <strong>${state.total}</strong> 条记录。`
    : state.featuredAgents?.configured
      ? `共 <strong>${state.total}</strong> 条记录，管理员置顶案例优先，其余按更新时间倒序。`
      : `共 <strong>${state.total}</strong> 条记录，按更新时间倒序。`;
}

function renderPagination() {
  const pagination = $('agent-pagination');
  if (!pagination) return;
  pagination.hidden = state.total === 0;
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const previous = $('agents-prev');
  const next = $('agents-next');
  if (previous) previous.disabled = state.loading || state.page <= 1;
  if (next) next.disabled = state.loading || state.page >= pages;
  const info = $('agents-page-info');
  if (info) {
    const start = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const end = state.total ? Math.min(start + state.items.length - 1, state.total) : 0;
    info.textContent = state.loading ? `第 ${state.page} / ${pages} 页 · 加载中…`
      : `第 ${state.page} / ${pages} 页 · 共 ${state.total} 条 · 显示 ${start}–${end} 条`;
  }
}

/** 卡片只展示专业与学校，其余信息在详情中查看。 */
function renderCardMeta(agent) {
  const rows = [
    ['专业', agent.major],
    ['学校', agent.schoolName]
  ].filter(([, value]) => Boolean(value));
  if (!rows.length) return '';
  return `<div class="agent-card-meta">${rows
    .map(([key, value]) => `<span class="meta-item"><em>${key}</em>${escapeHtml(value)}</span>`)
    .join('')}</div>`;
}

function renderCard(agent) {
  // 卡片整体可点开详情；因为内部还要放「打开智能体」链接，
  // 这里不能用 <button>（按钮内不允许嵌套链接），改用 role=button 的容器。
  const card = document.createElement('article');
  const popularity = state.usingDemo ? null : state.popular.get(agent.id);
  card.className = popularity ? 'agent-card agent-card-hot' : 'agent-card';
  card.dataset.agentId = agent.id;
  if (popularity) card.dataset.popularRank = String(popularity.rank);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.setAttribute('aria-label', `查看 ${agent.name} 详情`);

  const cover = agent.coverImage
    ? `<div class="agent-card-cover"><img src="${escapeHtml(agent.coverImage)}" alt="${escapeHtml(agent.name)} 封面" loading="lazy" /></div>`
    : '';
  const link = resolveAgentLink(agent.agentUrl);

  card.innerHTML = `
    ${cover}
    ${popularity ? `<span class="agent-popularity" title="${state.featuredAgents?.configured ? '管理员设置的热门展示位' : '按全库累计浏览次数排名，次数相同时按更新时间排序'}">热门 TOP ${popularity.rank}<em>${popularity.viewCount} 次浏览</em></span>` : ''}
    <div class="agent-card-name">${escapeHtml(agent.name)}</div>
    <p class="agent-card-summary">${escapeHtml(agent.summary || '暂无简介')}</p>
    ${renderCardMeta(agent)}
    <div class="agent-card-foot">
      <span class="status-dot" data-status="${escapeHtml(agent.status || 'active')}">${agent.status === 'inactive' ? '未启用' : '已启用'}</span>
      <span class="agent-card-time">${formatTime(agent.updatedAt)}</span>
    </div>
    ${
      link
        ? `<div class="agent-card-actions">
             <a class="agent-link" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" title="在新标签打开：${escapeHtml(link.href)}">打开智能体${EXTERNAL_ICON}</a>
           </div>`
        : ''
    }
  `;

  card.addEventListener('click', (event) => {
    // 卡片内链接自行跳转，不触发详情弹窗
    if (event.target.closest?.('.agent-link')) return;
    openDetail(agent.id);
  });
  card.addEventListener('keydown', (event) => {
    if (event.target !== card) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDetail(agent.id);
  });
  return card;
}

function renderGrid() {
  const grid = $('agent-grid');
  if (!grid) return;
  for (const dispose of cardCleanups.splice(0)) dispose();
  grid.innerHTML = '';

  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.gridColumn = '1 / -1';
    empty.innerHTML = `
      <div class="empty-state-title">没有匹配的智能体</div>
      <p>${state.query || state.discipline || state.school || state.status ? '换个关键词或清空筛选条件查看全部记录。' : '记录尚为空，可在管理端新增第一条智能体信息。'}</p>
    `;
    grid.appendChild(empty);
    return;
  }

  for (const agent of state.items) {
    const card = renderCard(agent);
    grid.appendChild(card);
    cardCleanups.push(mountCardTilt(card, state.cardEffects));
    const popularity = state.usingDemo ? null : state.popular.get(agent.id);
    if (popularity) cardCleanups.push(mountShaderCard(card, state.cardEffects, popularity.rank));
  }
}

/* ---------------- 详情弹窗 ---------------- */

function renderDetailBody(agent) {
  const tags = parseTags(agent.tags);
  const dataEntries = agent.data && typeof agent.data === 'object' ? Object.entries(agent.data) : [];
  const link = resolveAgentLink(agent.agentUrl);

  const infoRows = [
    ['学科门类', agent.discipline || '—'],
    ['具体专业', agent.major || '—'],
    ['课程名称', agent.courseName || '—'],
    ['所属学校', agent.schoolName || '—'],
    ['状态', agent.status === 'inactive' ? '未启用' : '已启用'],
    ['ID', agent.id],
    ['更新时间', formatTime(agent.updatedAt)],
    ...(agent.createdAt ? [['创建时间', formatTime(agent.createdAt)]] : [])
  ];

  return `
    ${agent.coverImage ? `<img class="detail-cover" src="${escapeHtml(agent.coverImage)}" alt="${escapeHtml(agent.name)} 封面" />` : ''}
    ${tags.length ? `<div class="tag-row">${tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
    <p class="section-label">简介</p>
    <p class="kv-value">${agent.summary ? escapeHtml(agent.summary) : '暂无简介'}</p>
    ${
      link
        ? `<p class="section-label">智能体链接</p>
    ${renderAgentLink(link)}`
        : ''
    }
    <p class="section-label">痛点</p>
    <p class="kv-value">${agent.painPoint ? escapeHtml(agent.painPoint) : '暂无描述'}</p>
    <p class="section-label">使用说明</p>
    <p class="kv-value">${agent.usageGuide ? escapeHtml(agent.usageGuide) : '暂无说明'}</p>
    <p class="section-label">记录信息</p>
    <div class="kv-grid">
      ${infoRows
        .map(
          ([key, value]) => `
        <div class="kv-key">${escapeHtml(key)}</div>
        <div class="kv-value mono">${escapeHtml(value)}</div>`
        )
        .join('')}
    </div>
    <p class="section-label">扩展字段</p>
    ${
      dataEntries.length
        ? `<div class="kv-grid">
            ${dataEntries
              .map(
                ([key, value]) => `
              <div class="kv-key">${escapeHtml(key)}</div>
              <div class="kv-value">${escapeHtml(
                typeof value === 'object' ? JSON.stringify(value, null, 2) : value
              )}</div>`
              )
              .join('')}
          </div>`
        : '<div class="kv-empty">该记录暂无扩展字段。后续新增的字段会显示在这里，无需调整页面代码。</div>'
    }
  `;
}

/** 弹窗副标题：学科 / 专业 / 课程 / 学校 一行摘要（辅助层级） */
function detailSubtitle(agent) {
  const parts = [agent.discipline, agent.major, agent.courseName, agent.schoolName].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return agent.status === 'inactive' ? '未启用' : '已启用';
}

async function recordView(agentId) {
  if (!state.session.backendReady || state.usingDemo || state.session.user?.isAdmin) return;
  try {
    await fetchJson(`/api/agents/${encodeURIComponent(agentId)}/views`, { method: 'POST' });
  } catch {
    /* 统计失败不阻断已加载的案例详情。 */
  }
}

async function openDetail(agentId, suggestedAgent = null) {
  let agent = state.items.find((item) => item.id === agentId)
    || (!state.usingDemo && suggestedAgent?.id === agentId ? suggestedAgent : null);
  if (!agent) return;
  state.detailId = agentId;
  const request = ++state.detailRequest;
  const backdrop = $('detail-backdrop');
  const title = $('detail-title');
  const subtitle = $('detail-subtitle');
  const body = $('detail-body');
  title.textContent = agent.name;
  if (subtitle) subtitle.textContent = detailSubtitle(agent);
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  body.innerHTML = state.usingDemo ? renderDetailBody(agent) : '<div class="kv-empty" role="status">详情加载中…</div>';
  $('detail-close')?.focus();

  // 列表接口不返回痛点 / 使用说明 / 扩展字段：打开时按 id 回查详情
  if (state.usingDemo) return;
  const isCurrent = () => !backdrop.hidden && state.detailId === agentId && state.detailRequest === request;
  try {
    const { ok, data } = await fetchJson(`/api/agents/${encodeURIComponent(agentId)}`);
    if (!isCurrent()) return;
    if (!ok || data?.item?.id !== agentId) throw new Error('detail_unavailable');
    agent = data.item;
    title.textContent = agent.name;
    if (subtitle) subtitle.textContent = detailSubtitle(agent);
    body.innerHTML = renderDetailBody(agent);
    void recordView(agentId);
  } catch {
    if (!isCurrent()) return;
    body.innerHTML = '<div class="kv-empty" role="status"><p>详情未加载，请重试以查看完整内容。</p><button class="btn btn-primary" id="detail-retry" type="button">重新加载详情</button></div>';
    $('detail-retry')?.addEventListener('click', () => openDetail(agentId, suggestedAgent));
  }
}

function closeDetail() {
  const backdrop = $('detail-backdrop');
  if (!backdrop) return;
  state.detailId = null;
  state.detailRequest += 1;
  backdrop.hidden = true;
  document.body.style.overflow = '';
}

/* ---------------- 数据加载 ---------------- */

const statusLabel = () => (state.status === 'inactive' ? '未启用' : state.status === 'active' ? '已启用' : '');

function buildQuery() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.discipline) params.set('discipline', state.discipline);
  if (state.school) params.set('school', state.school);
  if (state.status) params.set('status', state.status);
  params.set('limit', String(state.pageSize));
  params.set('offset', String((state.page - 1) * state.pageSize));
  return params.toString();
}

function matchDemo(agent) {
  const keyword = state.query.toLowerCase();
  const hitKeyword =
    !keyword || [agent.name, agent.summary, agent.tags, agent.discipline, agent.schoolName].join(' ').toLowerCase().includes(keyword);
  const hitDiscipline = !state.discipline || agent.discipline === state.discipline;
  const hitSchool = !state.school || agent.schoolName === state.school;
  const hitStatus = !state.status || (agent.status ?? 'active') === state.status;
  return hitKeyword && hitDiscipline && hitSchool && hitStatus;
}

function selectPopularAgents(items) {
  const ranked = items.filter((agent) => Number.isFinite(agent.viewStats?.viewCount) && agent.viewStats.viewCount >= 0)
    .sort((a, b) => b.viewStats.viewCount - a.viewStats.viewCount || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 3);
  return new Map(ranked.map((agent, index) => [agent.id, { rank: index + 1, viewCount: agent.viewStats.viewCount }]));
}

function selectFeaturedAgents(featuredAgents) {
  const positions = Array.isArray(featuredAgents?.agentIds) ? featuredAgents.agentIds : [];
  const items = Array.isArray(featuredAgents?.items) ? featuredAgents.items : [];
  return new Map(items
    .filter((agent) => Number.isInteger(agent.position) && agent.position >= 1 && agent.position <= 3
      && positions[agent.position - 1] === agent.id
      && Number.isFinite(agent.viewStats?.viewCount) && agent.viewStats.viewCount >= 0)
    .sort((a, b) => a.position - b.position)
    .map((agent) => [agent.id, { rank: agent.position, viewCount: agent.viewStats.viewCount }]));
}

async function loadFeaturedAgents() {
  try {
    const { ok, data } = await fetchJson('/api/featured-agents');
    if (!ok || typeof data?.configured !== 'boolean' || !Array.isArray(data.agentIds) || data.agentIds.length !== 3
      || !Array.isArray(data.items)) throw new Error('featured_unavailable');
    state.featuredAgents = data;
  } catch {
    state.featuredAgents = null;
  }
  return state.featuredAgents;
}

/** 排名读取全库，搜索 / 学科等筛选只改变显示的卡片。 */
async function loadPopularAgents(firstPage = null) {
  if (state.featuredAgents?.configured) return selectFeaturedAgents(state.featuredAgents);
  try {
    const items = [];
    let data = firstPage;
    do {
      if (!data) {
        const response = await fetchJson(`/api/agents?limit=500&offset=${items.length}`);
        if (!response.ok || !Array.isArray(response.data?.items)) throw new Error('views_unavailable');
        data = response.data;
      }
      items.push(...data.items);
      if (items.length >= data.total) return selectPopularAgents(items);
      if (!data.items.length) throw new Error('incomplete_views');
      data = null;
    } while (true);
  } catch {
    return new Map();
  }
}

async function loadAgents() {
  const requestId = ++state.listRequest;
  const requestedPage = state.page;
  const unfiltered = !state.query && !state.discipline && !state.school && !state.status;
  state.loading = true;
  renderPagination();
  const grid = $('agent-grid');
  if (grid) {
    grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  }

  const query = buildQuery();
  let items;
  let total;
  let usingDemo = false;
  let popular = new Map();
  try {
    const response = await fetch(`/api/agents?${query}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = await response.json();
    if (requestId !== state.listRequest) return;
    if (!Array.isArray(data.items) || !Number.isInteger(data.total) || data.total < 0) throw new Error('invalid_list');
    items = data.items;
    total = data.total;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / state.pageSize)));
    if (page !== requestedPage) {
      state.page = page;
      return loadAgents();
    }
    popular = await loadPopularAgents(unfiltered && requestedPage === 1 ? data : null);
  } catch {
    if (requestId !== state.listRequest) return;
    // 后端不可用：回退演示数据，保持页面可读（并在统计条显著提示）
    const filtered = DEMO_AGENTS.filter(matchDemo);
    total = filtered.length;
    state.page = Math.min(requestedPage, Math.max(1, Math.ceil(total / state.pageSize)));
    const offset = (state.page - 1) * state.pageSize;
    items = filtered.slice(offset, offset + state.pageSize);
    usingDemo = true;
  }

  if (requestId !== state.listRequest) return;
  state.items = items;
  state.total = total;
  state.loading = false;
  state.usingDemo = usingDemo;
  state.popular = popular;
  renderMeta();
  renderGrid();
  renderFilterCount();
  renderPagination();
}

/** 加载筛选选项（来自现有数据的学科 / 学校聚合） */
async function loadFilterOptions() {
  const bar = $('filter-bar');
  let stats = null;
  try {
    const { ok, data } = await fetchJson('/api/agents/stats');
    if (ok && data) stats = data;
  } catch {
    stats = null;
  }

  const disciplines = (stats?.disciplines ?? DEMO_AGENTS.map((agent) => ({ discipline: agent.discipline })))
    .map((entry) => entry.discipline)
    .filter(Boolean);
  const schools = (stats?.schools ?? DEMO_AGENTS.map((agent) => ({ schoolName: agent.schoolName })))
    .map((entry) => entry.schoolName)
    .filter(Boolean);

  const fill = (select, values, placeholder) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${placeholder}</option>`;
    for (const value of [...new Set(values)]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = values.includes(current) ? current : '';
  };

  fill($('filter-discipline'), disciplines, '全部学科');
  fill($('filter-school'), schools, '全部学校');
  if (bar) bar.hidden = disciplines.length === 0 && schools.length === 0;
  renderFilterCount();
}

function renderFilterCount() {
  const count = $('filter-count');
  if (!count) return;
  const activeCount = [state.discipline, state.school, statusLabel()].filter(Boolean).length;
  count.textContent = activeCount ? `已启用 ${activeCount} 个筛选条件` : '';
}

/* ---------------- 交互绑定 ---------------- */

function bindSearch() {
  const form = $('search-form');
  const input = $('search-input');
  const reset = $('search-reset');

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.query = input?.value.trim() ?? '';
    state.page = 1;
    return loadAgents();
  });

  reset?.addEventListener('click', () => {
    if (input) input.value = '';
    state.query = '';
    state.discipline = '';
    state.school = '';
    state.status = '';
    if ($('filter-discipline')) $('filter-discipline').value = '';
    if ($('filter-school')) $('filter-school').value = '';
    if ($('filter-status')) $('filter-status').value = '';
    state.page = 1;
    loadAgents();
    input?.focus();
  });
}

function bindFilters() {
  $('filter-discipline')?.addEventListener('change', (event) => {
    state.discipline = event.target.value;
    state.page = 1;
    return loadAgents();
  });
  $('filter-school')?.addEventListener('change', (event) => {
    state.school = event.target.value;
    state.page = 1;
    return loadAgents();
  });
  $('filter-status')?.addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    return loadAgents();
  });
  $('filter-clear')?.addEventListener('click', () => {
    state.discipline = '';
    state.school = '';
    state.status = '';
    if ($('filter-discipline')) $('filter-discipline').value = '';
    if ($('filter-school')) $('filter-school').value = '';
    if ($('filter-status')) $('filter-status').value = '';
    state.page = 1;
    return loadAgents();
  });
}

function bindPagination() {
  $('agents-prev')?.addEventListener('click', () => {
    if (state.loading || state.page <= 1) return;
    state.page -= 1;
    return loadAgents();
  });
  $('agents-next')?.addEventListener('click', () => {
    if (state.loading || state.page >= Math.ceil(state.total / state.pageSize)) return;
    state.page += 1;
    return loadAgents();
  });
}

function bindModal() {
  const backdrop = $('detail-backdrop');
  $('detail-close')?.addEventListener('click', closeDetail);
  backdrop?.addEventListener('click', (event) => {
    if (event.target === backdrop) closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && backdrop && !backdrop.hidden) closeDetail();
  });
}

/** 管理员在顶栏获得「管理端」入口（非管理员不渲染） */
function renderAdminEntry() {
  const host = document.querySelector('.app-topbar-left');
  if (!host) return;
  const existing = $('admin-entry');
  if (!state.session.user?.isAdmin) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const link = document.createElement('a');
  link.className = 'app-back';
  link.id = 'admin-entry';
  link.href = '/admin.html';
  link.textContent = '管理端 →';
  link.title = '进入管理端新增 / 维护智能体记录';
  host.appendChild(link);
}

async function refreshSession() {
  state.session = await loadSession();
  renderSessionChip($('session-area'), state.session, { onChange: refreshSession });
  renderAdminEntry();
  if (state.session.backendReady && !state.session.user) {
    // 未登录也可查询；仅提示可在首页/顶栏登录
    const chip = $('session-area')?.querySelector('.session-chip');
    if (chip) chip.title = '登录后可进入管理端维护数据';
  }
}

/* ---------------- 启动 ---------------- */

bindSearch();
bindFilters();
bindPagination();
bindModal();
initAgentChat({ openDetail });
await refreshSession();
await Promise.all([loadFilterOptions(), loadCardEffects(), loadFeaturedAgents()]);
await loadAgents();

// 登录 / 退出回调提示（login=ok / logout=1 / login_error=xx）
const authNotice = consumeAuthNotice();
if (authNotice.message) toast(authNotice.message, authNotice.tone);
