/**
 * 管理端页逻辑
 *
 * 门禁模型（双层）：
 *   1. 前端：按 /api/auth/me 的 isAdmin 决定显示内容还是门禁提示 —— 只负责体验
 *   2. 后端：写接口强制校验会话与管理员身份 —— 真正生效的边界
 *
 * 因此本页隐藏的内容不构成安全依赖；未授权者即使直接调接口也会被 401 / 403 拒绝。
 *
 * 功能：数据概览（总数 / 学科 / 学校）、记录列表（明细 / 编辑 / 删除）、
 *      新增与编辑同一表单（编辑时回填全字段）、封面上传（multipart）。
 */
import { consumeAuthNotice, escapeHtml, fetchJson, formatTime, loadSession, parseTags, renderAgentLink, renderSessionChip, resolveAgentLink, toast } from './session.js';
import { initCardEffects } from './card-effects-admin.js';

const $ = (id) => document.getElementById(id);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 与服务端 COVER_MIME_EXTENSIONS 对齐的可接受图片类型（上传前预检） */
const COVER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const state = {
  session: { user: null, ssoEnabled: false, backendReady: false },
  items: [],
  stats: null,
  editingId: null,
  uploading: false,
  submitting: false,
  coverUploadRequest: 0,
  detailRequest: 0,
  featuredConfigured: false,
  featuredPublishedAgentIds: [null, null, null],
  featuredDraftAgentIds: [null, null, null],
  featuredLoaded: false,
  featuredLoading: false,
  featuredSaving: false,
  featuredReadRequest: 0,
  featuredInitialized: false
};

/* ---------------- 门禁 ---------------- */

function showGate({ title, copy, actions }) {
  const gate = $('gate');
  const content = $('admin-content');
  if (!gate || !content) return;
  content.hidden = true;
  gate.hidden = false;
  $('gate-title').textContent = title;
  $('gate-copy').textContent = copy;

  const box = $('gate-actions');
  box.innerHTML = '';
  for (const action of actions) {
    const element = document.createElement(action.href ? 'a' : 'button');
    element.className = `btn ${action.primary ? 'btn-primary' : 'btn-ghost'}`;
    element.textContent = action.label;
    if (action.href) {
      element.href = action.href;
    } else {
      element.type = 'button';
      element.addEventListener('click', action.onClick);
    }
    box.appendChild(element);
  }
}

async function applyGate() {
  const { backendReady, user, ssoEnabled } = state.session;

  if (!backendReady) {
    return showGate({
      title: '未连接后端服务',
      copy: '管理端需要后端接口支持。请通过 http://127.0.0.1:2001/admin.html 访问（或先启动 node .preview-server.js）。',
      actions: [{ label: '打开站点入口', href: '/', primary: true }]
    });
  }

  if (!user) {
    return showGate({
      title: '需要登录',
      copy: ssoEnabled
        ? '管理端仅对管理员开放，请先使用超星统一认证登录。'
        : '本站尚未配置统一认证中心，登录暂不可用。',
      actions: [
        ...(ssoEnabled ? [{ label: '前往登录', href: '/api/auth/chaoxing/start', primary: true }] : []),
        { label: '回首页', href: '/' }
      ]
    });
  }

  if (!user.isAdmin) {
    return showGate({
      title: '无管理员权限',
      copy: `当前账号 ${user.displayName || user.name}（${user.role || '未知角色'}）不属于管理员，无法使用管理端。如需权限请联系管理员将角色加入 ADMIN_ROLES，或将 uid 加入 ADMIN_SSO_UIDS。`,
      actions: [
        { label: '进入查询平台', href: '/agents.html', primary: true },
        { label: '重新加载', onClick: () => window.location.reload() }
      ]
    });
  }

  $('gate').hidden = true;
  $('admin-content').hidden = false;
}

/* ---------------- 数据概览 ---------------- */

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  $('stat-total').textContent = String(stats.total ?? 0);

  const renderChips = (host, entries, mapper, emptyText) => {
    if (!host) return;
    host.innerHTML = '';
    if (!entries.length) {
      host.innerHTML = `<span class="muted">${emptyText}</span>`;
      return;
    }
    for (const entry of entries) {
      const chip = document.createElement('span');
      chip.className = 'stat-chip';
      const [label, total] = mapper(entry);
      chip.innerHTML = `${escapeHtml(label)}<span class="stat-chip-count mono">${total}</span>`;
      host.appendChild(chip);
    }
  };

  renderChips(
    $('stat-disciplines'),
    stats.disciplines ?? [],
    (entry) => [entry.discipline, entry.total],
    '暂无学科信息'
  );
  renderChips(
    $('stat-schools'),
    stats.schools ?? [],
    (entry) => [entry.schoolName, entry.total],
    '暂无学校信息'
  );

  fillDatalist($('discipline-options'), (stats.disciplines ?? []).map((entry) => entry.discipline));
  fillDatalist($('school-options'), (stats.schools ?? []).map((entry) => entry.schoolName));
}

function fillDatalist(list, values) {
  if (!list) return;
  list.innerHTML = '';
  for (const value of values) {
    if (!value) continue;
    const option = document.createElement('option');
    option.value = value;
    list.appendChild(option);
  }
}

async function loadStats() {
  try {
    const { ok, data } = await fetchJson('/api/agents/stats');
    state.stats = ok && data ? data : { total: 0, disciplines: [], schools: [] };
  } catch {
    state.stats = { total: 0, disciplines: [], schools: [] };
  }
  renderStats();
}

/* ---------------- 记录列表 ---------------- */

function renderCoverCell(agent) {
  if (!agent.coverImage) return '<span class="muted">—</span>';
  return `<img class="table-cover" src="${escapeHtml(agent.coverImage)}" alt="${escapeHtml(agent.name)} 封面" loading="lazy" />`;
}

function renderViewCell(agent) {
  const stats = agent.viewStats;
  if (!stats) return '<span class="muted">—</span>';
  return `<button class="link-btn" type="button" data-action="views" aria-label="${escapeHtml(agent.name)} 浏览明细" title="人数按登录账号去重；次数包含登录用户与匿名访客">${stats.userCount} 人 / ${stats.viewCount} 次</button>
    <div class="cell-sub">匿名访客 ${stats.anonymousCount}</div>`;
}

function renderRows() {
  const tbody = $('agent-rows');
  const empty = $('agent-empty');
  if (!tbody) return;
  tbody.innerHTML = '';
  $('agent-total').textContent = String(state.items.length);
  empty.hidden = state.items.length > 0;

  for (const agent of state.items) {
    const row = document.createElement('tr');
    row.dataset.agentId = agent.id;
    if (agent.id === state.editingId) row.classList.add('row-editing');
    const place = [agent.discipline, agent.schoolName].filter(Boolean).join(' · ') || '—';
    row.innerHTML = `
      <td class="cell-cover">${renderCoverCell(agent)}</td>
      <td class="cell-name">
        <button class="link-btn" type="button" data-action="detail">${escapeHtml(agent.name)}</button>
        ${agent.courseName ? `<div class="cell-sub">${escapeHtml(agent.courseName)}</div>` : ''}
      </td>
      <td class="cell-muted">${escapeHtml(place)}</td>
      <td><span class="status-dot" data-status="${escapeHtml(agent.status || 'active')}">${agent.status === 'inactive' ? '未启用' : '已启用'}</span></td>
      <td class="cell-views">${renderViewCell(agent)}</td>
      <td class="cell-muted mono">${formatTime(agent.updatedAt)}</td>
      <td class="cell-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-action="edit">编辑</button>
        <button class="btn btn-ghost btn-sm btn-danger" type="button" data-action="delete">删除</button>
      </td>
    `;
    row.addEventListener('click', (event) => {
      const action = event.target?.dataset?.action ?? 'detail';
      if (action === 'detail') return openDetail(agent.id);
      if (action === 'edit') return startEdit(agent.id);
      if (action === 'delete') return confirmDelete(event.target, agent);
      if (action === 'views') return openViews(agent.id);
    });
    tbody.appendChild(row);
  }
}

async function loadAgents() {
  try {
    const response = await fetch('/api/agents?limit=500', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = await response.json();
    state.items = Array.isArray(data.items) ? data.items : [];
  } catch {
    state.items = [];
    toast('读取记录失败，请确认后端服务已启动', 'error');
  }
  renderRows();
  renderFeaturedSettingsOptions();
}

/* ---------------- 热门案例展示位 ---------------- */

function normalizeFeaturedAgentIds(agentIds) {
  const source = Array.isArray(agentIds) ? agentIds : [];
  return [0, 1, 2].map((index) => {
    const value = source[index];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  });
}

function featuredAgentIdsEqual(left, right) {
  const a = normalizeFeaturedAgentIds(left);
  const b = normalizeFeaturedAgentIds(right);
  return a.every((value, index) => value === b[index]);
}

function hasDuplicateFeaturedAgents(agentIds) {
  const selected = normalizeFeaturedAgentIds(agentIds).filter(Boolean);
  return new Set(selected).size !== selected.length;
}

function readFeaturedSettingsSelection() {
  return normalizeFeaturedAgentIds([1, 2, 3].map((position) => $(`featured-slot-${position}`)?.value));
}

function setFeaturedNotice(message, tone = '') {
  const notice = $('featured-notice');
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.tone = tone;
}

function setFeaturedControlsDisabled() {
  const disabled = !state.featuredLoaded || state.featuredLoading || state.featuredSaving;
  for (const position of [1, 2, 3]) {
    const select = $(`featured-slot-${position}`);
    if (select) select.disabled = disabled;
  }
  const save = $('featured-save');
  if (save) save.disabled = disabled;
}

function renderFeaturedSettingsOptions() {
  const selectedIds = normalizeFeaturedAgentIds(state.featuredDraftAgentIds);
  const availableIds = new Set(state.items.map((item) => item.id));

  for (const position of [1, 2, 3]) {
    const select = $(`featured-slot-${position}`);
    if (!select) continue;
    const selectedId = selectedIds[position - 1];
    select.innerHTML = '';

    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不展示';
    select.appendChild(empty);

    for (const agent of state.items) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = `${agent.name}${agent.status === 'inactive' ? '（未启用）' : ''}`;
      select.appendChild(option);
    }

    // 列表临时读取失败时保留未保存选择，避免一次刷新清空用户正在编辑的配置。
    if (selectedId && !availableIds.has(selectedId)) {
      const current = document.createElement('option');
      current.value = selectedId;
      current.textContent = `当前选择（${selectedId}）`;
      select.appendChild(current);
    }
    select.value = selectedId ?? '';
  }
  setFeaturedControlsDisabled();
}

function publishedFeaturedNotice() {
  if (!state.featuredConfigured) {
    return '当前尚未手动配置，查询页继续按浏览热度自动展示 TOP 3。保存后将切换为手动展示；三个位置全部留空并保存，会隐藏全部热门案例。';
  }
  if (state.featuredPublishedAgentIds.every((agentId) => agentId === null)) {
    return '当前已手动配置为不展示任何热门案例。';
  }
  return '当前热门 TOP 位置已由管理员手动配置。修改选择后点击“保存热门展示”生效。';
}

function handleFeaturedSettingsChange() {
  state.featuredDraftAgentIds = readFeaturedSettingsSelection();
  const dirty = !featuredAgentIdsEqual(state.featuredDraftAgentIds, state.featuredPublishedAgentIds);
  if (hasDuplicateFeaturedAgents(state.featuredDraftAgentIds)) {
    setFeaturedNotice('同一个案例不能重复占用多个热门位置，请为 TOP 1 / 2 / 3 选择不同案例。', 'error');
  } else if (dirty) {
    setFeaturedNotice('当前选择尚未保存；查询页仍使用上一次已发布的热门配置。', 'warn');
  } else {
    setFeaturedNotice(publishedFeaturedNotice());
  }
}

async function loadFeaturedSettings() {
  const request = ++state.featuredReadRequest;
  state.featuredLoading = true;
  setFeaturedControlsDisabled();
  setFeaturedNotice('正在读取当前热门展示配置…');

  try {
    const { ok, status, data } = await fetchJson('/api/featured-agents');
    if (request !== state.featuredReadRequest) return;
    if (!ok || !Array.isArray(data?.agentIds)) {
      state.featuredLoaded = false;
      setFeaturedNotice(
        status === 404 ? '热门展示接口不可用，请重启最新后端后重试。' : '读取热门展示配置失败，请刷新后重试。',
        'error'
      );
      return;
    }

    const published = normalizeFeaturedAgentIds(data.agentIds);
    const hasUnsavedChanges = !featuredAgentIdsEqual(
      state.featuredDraftAgentIds,
      state.featuredPublishedAgentIds
    );
    state.featuredConfigured = Boolean(data.configured);
    state.featuredPublishedAgentIds = published;
    state.featuredLoaded = true;
    if (!hasUnsavedChanges) state.featuredDraftAgentIds = [...published];
    renderFeaturedSettingsOptions();
    setFeaturedNotice(
      hasUnsavedChanges ? '已刷新已发布配置；你当前未保存的选择仍被保留。' : publishedFeaturedNotice(),
      hasUnsavedChanges ? 'warn' : ''
    );
  } catch {
    if (request !== state.featuredReadRequest) return;
    state.featuredLoaded = false;
    setFeaturedNotice('无法连接后端，未读取到热门展示配置，当前不能保存。', 'error');
  } finally {
    if (request === state.featuredReadRequest) {
      state.featuredLoading = false;
      setFeaturedControlsDisabled();
    }
  }
}

async function saveFeaturedSettings(event) {
  event?.preventDefault?.();
  if (!state.featuredLoaded || state.featuredLoading || state.featuredSaving) return;

  const agentIds = readFeaturedSettingsSelection();
  state.featuredDraftAgentIds = [...agentIds];
  if (hasDuplicateFeaturedAgents(agentIds)) {
    setFeaturedNotice('同一个案例不能重复占用多个热门位置，请选择不同案例后再保存。', 'error');
    return;
  }

  state.featuredSaving = true;
  state.featuredReadRequest += 1;
  setFeaturedControlsDisabled();
  setFeaturedNotice('正在保存热门展示配置…');

  try {
    const { ok, status, data } = await fetchJson('/api/featured-agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentIds })
    });
    if (!ok || !Array.isArray(data?.agentIds)) {
      const messageMap = {
        400: '热门位置选择不合法或案例已不存在，未保存当前修改。',
        401: '登录状态已失效，未保存当前修改。',
        403: '当前账号不是管理员，无法保存热门展示。',
        500: '热门展示保存失败，当前选择已保留，请稍后重试。'
      };
      setFeaturedNotice(messageMap[status] ?? `热门展示保存失败（HTTP ${status ?? '未知'}），当前选择已保留。`, 'error');
      return;
    }

    const saved = normalizeFeaturedAgentIds(data.agentIds);
    state.featuredConfigured = Boolean(data.configured ?? true);
    state.featuredPublishedAgentIds = saved;
    state.featuredDraftAgentIds = [...saved];
    state.featuredLoaded = true;
    renderFeaturedSettingsOptions();
    setFeaturedNotice(
      saved.every((agentId) => agentId === null)
        ? '保存成功：查询页将不展示任何热门案例。'
        : '保存成功：热门 TOP 1 / 2 / 3 已按当前选择更新。',
      'success'
    );
  } catch {
    setFeaturedNotice('无法连接后端，热门展示未保存；当前选择已保留。', 'error');
  } finally {
    state.featuredSaving = false;
    setFeaturedControlsDisabled();
  }
}

async function initFeaturedSettings() {
  if (!state.session.user?.isAdmin) return;
  if (!state.featuredInitialized) {
    state.featuredInitialized = true;
    $('featured-settings-form')?.addEventListener('submit', saveFeaturedSettings);
    for (const position of [1, 2, 3]) {
      $(`featured-slot-${position}`)?.addEventListener('change', handleFeaturedSettingsChange);
    }
  }
  renderFeaturedSettingsOptions();
  await loadFeaturedSettings();
}

/* ---------------- 删除（二次确认：按钮变红再点一次） ---------------- */

let pendingDelete = null;

function resetPendingDelete() {
  if (!pendingDelete) return;
  pendingDelete.element.textContent = '删除';
  pendingDelete.element.classList.remove('btn-confirming');
  window.clearTimeout(pendingDelete.timer);
  pendingDelete = null;
}

function confirmDelete(element, agent) {
  if (pendingDelete?.agentId === agent.id) {
    resetPendingDelete();
    return removeAgent(agent, element);
  }
  resetPendingDelete();
  element.textContent = '确认删除？';
  element.classList.add('btn-confirming');
  const timer = window.setTimeout(() => resetPendingDelete(), 4000);
  pendingDelete = { agentId: agent.id, element, timer };
}

async function removeAgent(agent, element) {
  element.disabled = true;
  element.textContent = '删除中…';
  try {
    const { ok, status } = await fetchJson(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' });
    if (!ok) {
      element.disabled = false;
      element.textContent = '删除';
      toast(`删除失败（HTTP ${status}）`, 'error');
      return;
    }
    toast(`已删除：${agent.name}`);
    if (state.editingId === agent.id) resetForm();
    await Promise.all([loadAgents(), loadStats()]);
  } catch {
    element.disabled = false;
    element.textContent = '删除';
    toast('无法连接后端服务', 'error');
  }
}

/* ---------------- 明细弹窗 ---------------- */

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
        ? `<div class="kv-grid">${dataEntries
            .map(
              ([key, value]) => `
          <div class="kv-key">${escapeHtml(key)}</div>
          <div class="kv-value">${escapeHtml(
            typeof value === 'object' ? JSON.stringify(value, null, 2) : value
          )}</div>`
            )
            .join('')}</div>`
        : '<div class="kv-empty">该记录暂无扩展字段。</div>'
    }
  `;
}

async function openDetail(agentId) {
  const request = ++state.detailRequest;
  const backdrop = $('detail-backdrop');
  const body = $('detail-body');
  const title = $('detail-title');
  const subtitle = $('detail-subtitle');
  if (!backdrop || !body) return;

  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  title.textContent = '记录明细';
  if (subtitle) subtitle.textContent = '';
  body.innerHTML = '<div class="kv-empty">加载中…</div>';

  let agent = state.items.find((item) => item.id === agentId) ?? null;
  try {
    const { ok, data } = await fetchJson(`/api/agents/${encodeURIComponent(agentId)}`);
    if (ok && data?.item) agent = data.item;
  } catch {
    /* 详情接口失败时退回列表数据 */
  }

  if (backdrop.hidden || state.detailRequest !== request) return;

  if (!agent) {
    body.innerHTML = '<div class="kv-empty">未找到该记录。</div>';
    return;
  }

  title.textContent = agent.name;
  if (subtitle) {
    subtitle.textContent =
      [agent.discipline, agent.major, agent.courseName, agent.schoolName].filter(Boolean).join(' · ') ||
      formatTime(agent.updatedAt);
  }
  body.innerHTML = renderDetailBody(agent);
}

function closeDetail() {
  state.detailRequest += 1;
  const backdrop = $('detail-backdrop');
  if (!backdrop) return;
  backdrop.hidden = true;
  document.body.style.overflow = '';
}

/* ---------------- 浏览明细（仅管理员） ---------------- */

async function openViews(agentId, offset = 0) {
  const agent = state.items.find((item) => item.id === agentId);
  if (!agent) return;
  const request = ++state.detailRequest;
  const backdrop = $('detail-backdrop');
  const body = $('detail-body');
  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  $('detail-title').textContent = `${agent.name} · 浏览明细`;
  $('detail-subtitle').textContent = '登录人数按账号去重；匿名访客按浏览器单独统计。';
  body.innerHTML = '<div class="kv-empty" role="status">浏览明细加载中…</div>';
  $('detail-close')?.focus();
  const isCurrent = () => !backdrop.hidden && state.detailRequest === request;
  try {
    const { ok, data } = await fetchJson(`/api/agents/${encodeURIComponent(agentId)}/views?limit=20&offset=${offset}`);
    if (!isCurrent()) return;
    if (!ok || !Array.isArray(data?.items) || !data.viewStats) throw new Error('views_unavailable');
    const stats = data.viewStats;
    body.innerHTML = `
      <p class="kv-value">登录用户 <strong>${stats.userCount || 0}</strong> 人 · 匿名访客 <strong>${stats.anonymousCount || 0}</strong> 个 · 浏览 <strong>${stats.viewCount || 0}</strong> 次</p>
      <p class="field-hint">成功打开案例详情才计入，管理员访问不计入。统计从功能启用后开始累积，匿名访客数不等同于实际人数。</p>
      ${data.items.length ? data.items.map((visitor) => `
        <section class="view-visitor">
          <p class="kv-value"><strong>${escapeHtml(visitor.displayName)}</strong> ${visitor.visitorType === 'user' ? '<span class="muted">已登录用户</span>' : ''}</p>
          <div class="kv-grid">
            <div class="kv-key">浏览次数</div><div class="kv-value">${visitor.viewCount || 0} 次</div>
            <div class="kv-key">首次浏览</div><div class="kv-value mono">${formatTime(visitor.firstViewedAt)}</div>
            <div class="kv-key">最近浏览</div><div class="kv-value mono">${formatTime(visitor.lastViewedAt)}</div>
          </div>
        </section>`).join('') : '<div class="kv-empty">暂无浏览记录。</div>'}
      <div class="view-pagination">
        <button class="btn btn-ghost btn-sm" id="views-prev" type="button" ${offset === 0 ? 'disabled' : ''}>上一页</button>
        <span class="muted">共 ${data.total} 条${data.total ? ` · 第 ${Math.floor(offset / 20) + 1} 页` : ''}</span>
        <button class="btn btn-ghost btn-sm" id="views-next" type="button" ${offset + 20 >= data.total ? 'disabled' : ''}>下一页</button>
      </div>`;
    $('views-prev')?.addEventListener('click', () => openViews(agentId, Math.max(0, offset - 20)));
    $('views-next')?.addEventListener('click', () => openViews(agentId, offset + 20));
  } catch {
    if (!isCurrent()) return;
    body.innerHTML = '<div class="kv-empty" role="status"><p>浏览明细加载失败，请重试。</p><button class="btn btn-primary" id="views-retry" type="button">重新加载浏览明细</button></div>';
    $('views-retry')?.addEventListener('click', () => openViews(agentId, offset));
  }
}

/* ---------------- 封面 ---------------- */

function setCoverPreview(url) {
  const preview = $('cover-preview');
  if (!preview) return;
  if (url) {
    preview.dataset.empty = 'false';
    preview.innerHTML = `<img src="${escapeHtml(url)}" alt="封面预览" />`;
  } else {
    preview.dataset.empty = 'true';
    preview.innerHTML = '<span class="cover-preview-empty">暂无封面</span>';
  }
}

function setCoverStatus(text, tone = '') {
  const status = $('cover-status');
  if (!status) return;
  status.textContent = text ?? '';
  status.dataset.tone = tone;
}

function cancelCoverUpload() {
  state.coverUploadRequest += 1;
  state.uploading = false;
  $('form-submit').disabled = state.submitting;
  return state.coverUploadRequest;
}

/** 上传失败状态码 → 中文提示（404 额外给出「后端进程未重启」的排查方向） */
const UPLOAD_ERROR_TEXT = {
  400: '上传内容不合法，请重新选择图片。',
  401: '登录状态已失效，请重新登录后再上传。',
  403: '当前账号不是管理员，无权上传封面。',
  404: '上传接口不存在（/api/uploads）：后端可能仍是旧进程，请重启后端后重试。',
  413: '图片超过 10 MB 上限，请压缩后重试。',
  415: '仅支持 PNG / JPG / WebP / GIF 格式。'
};

const UPLOAD_ERROR_CODE_TEXT = {
  invalid_image_data: '文件内容不是有效图片（扩展名与实际格式不符），请重新导出后再上传。',
  empty_file: '图片内容为空，请重新选择。',
  file_required: '未接收到图片文件，请重新选择。',
  multipart_required: '上传请求格式不正确，请刷新页面后重试。',
  upload_failed: '服务端保存失败，请稍后重试。'
};

async function uploadCover(file) {
  if (!file) return;
  if (state.submitting) {
    setNotice('正在提交，请提交完成后再上传封面。', 'warn');
    return;
  }
  const request = cancelCoverUpload();

  // 前置校验（与服务端白名单/上限保持一致，避免无谓请求与难懂的报错）
  if (!COVER_MIME_TYPES.has(file.type)) {
    const message = `不支持的图片格式${file.type ? `（${file.type}）` : ''}，仅支持 PNG / JPG / WebP / GIF。`;
    setCoverStatus(message, 'error');
    setNotice(message, 'error');
    return;
  }
  if (!file.size) {
    setCoverStatus('图片内容为空，请重新选择。', 'error');
    setNotice('图片内容为空，请重新选择。', 'error');
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const message = `图片过大（${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩到 10 MB 以内。`;
    setCoverStatus(message, 'error');
    setNotice(message, 'error');
    return;
  }

  const form = new FormData();
  // 显式带文件名：服务端按 filename 识别文件字段
  form.append('file', file, file.name || 'cover.png');
  state.uploading = true;
  $('form-submit').disabled = true;
  setCoverStatus(`上传中：${file.name || '封面图片'}…`);
  setNotice('封面正在上传…', '');

  try {
    const response = await fetch('/api/uploads', {
      method: 'POST',
      credentials: 'same-origin',
      body: form
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (state.coverUploadRequest !== request) return;
    if (!response.ok || !data?.url) {
      const message =
        UPLOAD_ERROR_CODE_TEXT[data?.error] ??
        UPLOAD_ERROR_TEXT[response.status] ??
        `封面上传失败（HTTP ${response.status}）。`;
      setNotice(message, 'error');
      setCoverStatus(message, 'error');
      return;
    }
    $('field-cover').value = data.url;
    setCoverPreview(data.url);
    setCoverStatus('上传成功，提交案例后保存。', 'success');
    setNotice(`封面已上传：${data.url}（提交表单后生效）`, 'success');
  } catch {
    if (state.coverUploadRequest !== request) return;
    setCoverStatus('无法连接后端服务，封面上传失败。', 'error');
    setNotice('无法连接后端服务，封面上传失败。', 'error');
  } finally {
    if (state.coverUploadRequest === request) {
      state.uploading = false;
      $('form-submit').disabled = state.submitting;
    }
  }
}

/* ---------------- 表单（新增 / 编辑） ---------------- */

/** 字段中文名（提交后回查用） */
const FIELD_LABELS = {
  summary: '简介',
  tags: '标签',
  discipline: '学科门类',
  major: '具体专业',
  courseName: '课程名称',
  schoolName: '所属学校',
  agentUrl: '智能体链接',
  coverImage: '案例封面',
  painPoint: '痛点',
  usageGuide: '使用说明'
};

/**
 * 提交后回查接口返回：已填写但未落库的字段
 *
 * 用途：字段名不一致或后端仍是旧版本（不认识新字段）时，接口会静默丢弃这些字段，
 * 表现为「管理端填了、前台不显示」。这里把静默失败转成显式提示，便于定位。
 * @returns {string[]} 未保存成功字段的中文名
 */
function droppedFields(payload, item) {
  if (!item) return [];
  return Object.entries(FIELD_LABELS)
    .filter(([key]) => Boolean(payload[key]))
    .filter(([key]) => String(item[key] ?? '') !== String(payload[key]))
    .map(([, label]) => label);
}

function setNotice(message, tone = '', visible = true) {
  const notice = $('create-notice');
  if (!notice) return;
  notice.hidden = !visible;
  notice.dataset.tone = tone;
  notice.textContent = message ?? '';
}

function readForm() {
  return {
    name: $('field-name').value.trim(),
    summary: $('field-summary').value.trim(),
    tags: $('field-tags').value.trim(),
    discipline: $('field-discipline').value.trim(),
    major: $('field-major').value.trim(),
    courseName: $('field-course').value.trim(),
    schoolName: $('field-school').value.trim(),
    agentUrl: $('field-url').value.trim(),
    coverImage: $('field-cover').value.trim(),
    painPoint: $('field-pain').value.trim(),
    usageGuide: $('field-guide').value.trim(),
    status: $('field-status').value,
    rawData: $('field-data').value.trim()
  };
}

function fillForm(agent) {
  cancelCoverUpload();
  $('field-name').value = agent.name ?? '';
  $('field-summary').value = agent.summary ?? '';
  $('field-tags').value = agent.tags ?? '';
  $('field-discipline').value = agent.discipline ?? '';
  $('field-major').value = agent.major ?? '';
  $('field-course').value = agent.courseName ?? '';
  $('field-school').value = agent.schoolName ?? '';
  $('field-url').value = agent.agentUrl ?? '';
  $('field-cover').value = agent.coverImage ?? '';
  $('field-pain').value = agent.painPoint ?? '';
  $('field-guide').value = agent.usageGuide ?? '';
  $('field-status').value = agent.status === 'inactive' ? 'inactive' : 'active';
  $('field-data').value = agent.data && Object.keys(agent.data).length ? JSON.stringify(agent.data, null, 2) : '';
  setCoverPreview(agent.coverImage ?? '');
  setCoverStatus('');
}

const CREATE_DRAFT_FIELDS = [
  'field-name', 'field-summary', 'field-tags', 'field-discipline', 'field-major',
  'field-course', 'field-school', 'field-url', 'field-cover', 'field-pain',
  'field-guide', 'field-status', 'field-data'
];

function createDraftKey() {
  const uid = state.session.user?.ssoUid;
  if (!uid) throw new Error('draft_identity_unavailable');
  return `agent-site:create-draft:${uid}`;
}

function clearCreateDraft() {
  try {
    localStorage.removeItem(createDraftKey());
    return true;
  } catch {
    setNotice('无法清除浏览器草稿，请检查浏览器存储设置。', 'error');
    return false;
  }
}

function saveCreateDraft(showMessage = true) {
  if (state.editingId || state.submitting) return false;
  if (showMessage && state.uploading) {
    setNotice('封面正在上传，请上传完成后再暂存。', 'warn');
    return false;
  }
  const draft = Object.fromEntries(CREATE_DRAFT_FIELDS.map((id) => [id, $(id).value]));
  const hasContent = Object.entries(draft).some(([id, value]) => id === 'field-status' ? value === 'inactive' : value !== '');
  if (!hasContent) {
    const cleared = clearCreateDraft();
    if (showMessage && cleared) setNotice('表单为空，已清除草稿。', 'success');
    return cleared || !showMessage;
  }
  try {
    localStorage.setItem(createDraftKey(), JSON.stringify(draft));
    if (showMessage) {
      setNotice('草稿已暂存到当前浏览器，重新打开可继续填写。', 'success');
      toast('草稿已暂存');
    }
    return true;
  } catch {
    setNotice('暂存失败，当前内容已保留。请检查浏览器存储是否可用。', 'error');
    return false;
  }
}

function restoreCreateDraft() {
  try {
    const stored = localStorage.getItem(createDraftKey());
    if (!stored) return;
    const draft = JSON.parse(stored);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('invalid_draft');
    for (const id of CREATE_DRAFT_FIELDS) {
      if (typeof draft[id] === 'string') $(id).value = draft[id];
    }
    setCoverPreview($('field-cover').value);
    setNotice('已恢复当前浏览器中暂存的草稿。', 'success');
  } catch {
    setNotice('无法读取浏览器草稿，可继续填写并重新暂存。', 'warn');
  }
}

function resetForm() {
  cancelCoverUpload();
  state.editingId = null;
  $('agent-form').reset();
  $('field-status').value = 'active';
  setCoverPreview('');
  setCoverStatus('');
  setNotice('', '', false);
  $('form-title').textContent = '新增智能体';
  $('form-hint').textContent = '填写名称后即可提交；学科、学校、封面等字段会直接展示在查询平台卡片与详情中。';
  $('form-submit').textContent = '提交新增';
  $('form-reset').textContent = '清空表单';
  $('form-cancel').hidden = true;
  $('form-draft').hidden = false;
  $('form-draft-hint').hidden = false;
  renderRows();
}

function openForm() {
  $('form-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  $('form-body').scrollTop = 0;
  $('field-name').focus();
}

function closeForm(saveBeforeClose = true) {
  if (state.submitting) return;
  if (saveBeforeClose && !state.editingId && !saveCreateDraft(false)) return;
  $('form-backdrop').hidden = true;
  document.body.style.overflow = '';
  resetForm();
  $('agent-create').focus();
}

async function startEdit(agentId) {
  const request = cancelCoverUpload();
  setNotice('', '', false);
  let agent = state.items.find((item) => item.id === agentId) ?? null;
  try {
    const { ok, data } = await fetchJson(`/api/agents/${encodeURIComponent(agentId)}`);
    if (ok && data?.item) agent = data.item;
  } catch {
    /* 详情拉取失败时退回列表数据（缺长文本字段） */
  }
  if (state.coverUploadRequest !== request) return;
  if (!agent) {
    toast('未找到该记录，无法编辑', 'error');
    return;
  }

  state.editingId = agentId;
  fillForm(agent);
  $('form-title').textContent = `编辑：${agent.name}`;
  $('form-hint').textContent = '修改后提交即覆盖原记录；未改动的字段保持原值。';
  $('form-submit').textContent = '保存修改';
  $('form-reset').textContent = '还原为原值';
  $('form-cancel').hidden = false;
  $('form-draft').hidden = true;
  $('form-draft-hint').hidden = true;
  renderRows();
  openForm();
}

async function submitForm(event) {
  event.preventDefault();
  if (state.uploading) {
    setNotice('封面正在上传，请上传完成后再提交。', 'warn');
    return;
  }
  if (state.submitting) return;
  const submit = $('form-submit');
  const payload = readForm();

  if (!payload.name) {
    setNotice('名称不能为空。', 'error');
    $('field-name').focus();
    return;
  }

  let dataPayload = null;
  if (payload.rawData) {
    try {
      dataPayload = JSON.parse(payload.rawData);
    } catch {
      setNotice('扩展字段不是合法的 JSON，请检查格式。', 'error');
      $('field-data').focus();
      return;
    }
    if (typeof dataPayload !== 'object' || dataPayload === null || Array.isArray(dataPayload)) {
      setNotice('扩展字段必须是 JSON 对象（以 { } 包裹的键值对）。', 'error');
      $('field-data').focus();
      return;
    }
  }

  const body = {
    name: payload.name,
    summary: payload.summary,
    tags: payload.tags,
    discipline: payload.discipline,
    major: payload.major,
    courseName: payload.courseName,
    schoolName: payload.schoolName,
    agentUrl: payload.agentUrl,
    coverImage: payload.coverImage,
    painPoint: payload.painPoint,
    usageGuide: payload.usageGuide,
    status: payload.status,
    data: dataPayload ?? {}
  };

  const editing = Boolean(state.editingId);
  let closeAfterSave = false;
  const originalSubmitText = submit.textContent;
  state.submitting = true;
  submit.disabled = true;
  $('form-close').disabled = true;
  $('form-draft').disabled = true;
  submit.textContent = editing ? '保存中…' : '提交中…';
  setNotice('', '', false);

  try {
    const { ok, status, data } = await fetchJson(
      editing ? `/api/agents/${encodeURIComponent(state.editingId)}` : '/api/agents',
      {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (ok) {
      const name = data?.item?.name ?? payload.name;
      const dropped = droppedFields(payload, data?.item);
      // 先重置表单（会清空提示条），再写结果提示，避免成功提示被 resetForm 抹掉
      resetForm();
      if (dropped.length) {
        setNotice(
          `${editing ? '已保存修改' : '新增成功'}：${name}；但以下字段未写入数据库：${dropped.join('、')}。请确认后端服务已重启到最新版本后重试。`,
          'warn'
        );
        toast(`部分字段未保存：${dropped.join('、')}`, 'error');
      } else {
        setNotice(editing ? `已保存修改：${name}` : `新增成功：${name}`, 'success');
        toast(editing ? '已保存修改' : '已新增 1 条智能体记录');
        closeAfterSave = true;
      }
      await Promise.all([loadAgents(), loadStats()]);
      return;
    }

    const messageMap = {
      401: '登录状态已失效，请重新登录后再试。',
      403: '当前账号不是管理员，无权写入记录。',
      400: `提交内容不合法（${data?.error ?? 'bad_request'}）。`,
      404: '该记录已不存在，可能已被删除。',
      413: '提交内容过大，请精简后重试。',
      500: '服务端写入失败，请稍后重试。'
    };
    setNotice(messageMap[status] ?? `提交失败（HTTP ${status}）。`, 'error');
  } catch {
    setNotice('无法连接后端服务，请确认服务已启动。', 'error');
  } finally {
    state.submitting = false;
    $('form-close').disabled = false;
    $('form-draft').disabled = false;
    submit.disabled = state.uploading;
    submit.textContent = state.editingId ? '保存修改' : originalSubmitText.replace(/…$/, '');
    if (!state.editingId) submit.textContent = '提交新增';
    if (closeAfterSave) {
      if (!editing && !clearCreateDraft()) toast('案例已提交，但本地草稿未能清除。', 'error');
      closeForm(false);
    }
  }
}

/* ---------------- 会话 ---------------- */

async function refreshSession() {
  state.session = await loadSession();
  renderSessionChip($('session-area'), state.session, { onChange: refreshSession });
  await applyGate();
}

/* ---------------- 事件绑定与启动 ---------------- */

$('detail-close')?.addEventListener('click', closeDetail);
$('detail-backdrop')?.addEventListener('click', (event) => {
  if (event.target === $('detail-backdrop')) closeDetail();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('form-backdrop')?.hidden) return closeForm();
  if (event.key === 'Escape' && !$('detail-backdrop')?.hidden) closeDetail();
});

$('agent-create')?.addEventListener('click', () => {
  resetForm();
  restoreCreateDraft();
  openForm();
});
$('form-close')?.addEventListener('click', closeForm);
$('form-draft')?.addEventListener('click', () => saveCreateDraft());

$('refresh-list')?.addEventListener('click', loadAgents);
$('refresh-all')?.addEventListener('click', async () => {
  await Promise.all([
    loadAgents(),
    loadStats(),
    ...(state.session.user?.isAdmin ? [loadFeaturedSettings()] : [])
  ]);
  toast('已刷新');
});
$('agent-form')?.addEventListener('submit', submitForm);
$('form-cancel')?.addEventListener('click', closeForm);
$('form-reset')?.addEventListener('click', () => {
  cancelCoverUpload();
  setCoverStatus('');
  setNotice('', '', false);
  if (!state.editingId) clearCreateDraft();
  window.setTimeout(() => {
    if (state.editingId) {
      const agent = state.items.find((item) => item.id === state.editingId);
      if (agent) {
        $('agent-form')?.reset();
        fillForm(agent);
      }
    } else {
      $('field-status').value = 'active';
      setCoverPreview('');
    }
  }, 0);
});

$('field-cover')?.addEventListener('input', (event) => {
  cancelCoverUpload();
  setCoverStatus('');
  setCoverPreview(event.target.value.trim());
});
$('cover-clear')?.addEventListener('click', () => {
  cancelCoverUpload();
  $('field-cover').value = '';
  setCoverPreview('');
  setCoverStatus('');
});
$('cover-file')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  await uploadCover(file);
});

await refreshSession();
if (state.session.user?.isAdmin) initCardEffects({ isAdmin: () => Boolean(state.session.user?.isAdmin) });
await Promise.all([loadAgents(), loadStats()]);
if (state.session.user?.isAdmin) await initFeaturedSettings();

// 登录 / 退出回调提示（login=ok / logout=1 / login_error=xx）
const authNotice = consumeAuthNotice();
if (authNotice.message) toast(authNotice.message, authNotice.tone);
