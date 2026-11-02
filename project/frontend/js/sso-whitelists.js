import { fetchJson } from './session.js';

const API_URL = '/api/sso-whitelists';

function element(tagName, className = '', text = '') {
  const node = document.createElement(tagName);
  node.className = className;
  node.textContent = text;
  return node;
}

function errorMessage(status, code) {
  if (status === 401) return '登录状态已失效，请重新登录后再操作';
  if (status === 403 || code === 'sso_whitelist_forbidden') return '该账号未获认证中心白名单管理授权';
  if (status === 503 || code === 'sso_whitelist_not_configured') return '认证中心白名单管理尚未配置';
  if (code === 'sso_whitelist_center_unauthorized') return '认证中心拒绝访问，请检查两端密钥与认证中心版本配置';
  if (code === 'sso_whitelist_center_unavailable' || status === 502) return '认证中心暂时不可用，请稍后刷新重试';
  if (code === 'sso_whitelist_center_timeout' || status === 504) return '认证中心响应超时，请稍后刷新重试';
  if (status === 400) return '填写内容不合法，请检查后重试';
  if (status === 404) return '目标名单记录不存在，请刷新后重试';
  if (status === 409) return '名单记录已存在或状态冲突，请刷新确认';
  return '白名单读取失败，请稍后刷新重试';
}

function inputField({ id, label, placeholder, type = 'text', maxLength }) {
  const wrap = element('div', 'field');
  const caption = element('label', '', label);
  caption.setAttribute('for', id);
  const input = element('input', 'input');
  input.id = id;
  input.type = type;
  input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  wrap.append(caption, input);
  return { wrap, input };
}

function validOrigin(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export async function initSsoWhitelists({ root, user }) {
  if (!root || !user?.isAdmin) return null;

  const state = {
    loaded: false,
    busy: false,
    fids: [],
    origins: [],
    actionButtons: [],
    confirmDelete: ''
  };

  const body = element('div', 'sso-whitelists-body');
  const operatorLine = element('p', 'sso-whitelists-operator-line');
  operatorLine.append(element('span', '', '当前操作账号 UID：'));
  const operator = element('code', 'mono', String(user.ssoUid ?? '未提供'));
  operator.id = 'sso-whitelists-operator';
  operatorLine.append(operator);

  const toolbar = element('div', 'sso-whitelists-toolbar');
  const status = element('p', 'notice', '正在读取认证中心白名单…');
  status.id = 'sso-whitelists-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const refresh = element('button', 'btn btn-ghost btn-sm', '刷新名单');
  refresh.id = 'sso-whitelists-refresh';
  refresh.type = 'button';
  toolbar.append(status, refresh);

  const fidSection = element('section', 'sso-whitelists-section');
  fidSection.append(element('h3', '', '共享机构 FID'));
  const fidForm = element('form', 'sso-whitelists-form');
  fidForm.id = 'sso-fid-form';
  const fidField = inputField({ id: 'sso-fid', label: '机构 FID', placeholder: '仅填写数字', maxLength: 32 });
  const fidNameField = inputField({ id: 'sso-fid-name', label: '机构名称', placeholder: '可选，例如：示例大学', maxLength: 200 });
  fidField.input.inputMode = 'numeric';
  const fidAdd = element('button', 'btn btn-primary', '新增机构');
  fidAdd.id = 'sso-fid-add';
  fidAdd.type = 'submit';
  fidForm.append(fidField.wrap, fidNameField.wrap, fidAdd);
  const fidList = element('div', 'table-wrap sso-whitelists-list');
  fidList.id = 'sso-fid-list';
  fidSection.append(fidForm, fidList);

  const originSection = element('section', 'sso-whitelists-section');
  originSection.append(element('h3', '', '共享回跳域名'));
  const originForm = element('form', 'sso-whitelists-form');
  originForm.id = 'sso-origin-form';
  const originField = inputField({ id: 'sso-origin', label: 'HTTP(S) Origin', placeholder: 'https://example.edu', type: 'url' });
  const originNoteField = inputField({ id: 'sso-origin-note', label: '备注', placeholder: '可选，例如：课程案例库', maxLength: 200 });
  const originAdd = element('button', 'btn btn-primary', '新增域名');
  originAdd.id = 'sso-origin-add';
  originAdd.type = 'submit';
  originForm.append(originField.wrap, originNoteField.wrap, originAdd);
  const originList = element('div', 'table-wrap sso-whitelists-list');
  originList.id = 'sso-origin-list';
  originSection.append(originForm, originList);

  body.append(operatorLine, toolbar, fidSection, originSection);
  root.append(body);

  const formControls = [fidField.input, fidNameField.input, fidAdd, originField.input, originNoteField.input, originAdd];

  function setStatus(message, tone = '') {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function syncDisabled() {
    const writeDisabled = state.busy || !state.loaded;
    for (const control of formControls) control.disabled = writeDisabled;
    for (const button of state.actionButtons) button.disabled = writeDisabled;
    refresh.disabled = state.busy;
  }

  function actionButton(label, kind, action, key) {
    const button = element('button', `btn btn-ghost btn-sm${action === 'delete' ? ' btn-danger' : ''}`, label);
    button.type = 'button';
    button.dataset.kind = kind;
    button.dataset.action = action;
    button.dataset.key = key;
    button.addEventListener('click', async () => {
      if (action === 'delete') {
        const token = `${kind}:${key}`;
        if (state.confirmDelete !== token) {
          state.confirmDelete = token;
          button.textContent = '确认删除';
          return;
        }
      }
      const payload = { kind, action };
      payload[kind === 'fid' ? 'fid' : 'origin'] = key;
      await write(payload);
    });
    state.actionButtons.push(button);
    return button;
  }

  function renderTable(kind, entries, host) {
    state.confirmDelete = '';
    const table = element('table', 'data-table sso-whitelists-table');
    const body = element('tbody');
    if (!entries.length) {
      const row = element('tr');
      const cell = element('td', 'muted', '暂无记录');
      cell.colSpan = 4;
      row.append(cell);
      body.append(row);
    }
    for (const entry of entries) {
      const key = kind === 'fid' ? String(entry.fid) : String(entry.origin);
      const row = element('tr');
      row.append(
        element('td', 'mono', key),
        element('td', '', String(kind === 'fid' ? entry.name ?? '' : entry.note ?? '')),
        element('td', '', entry.enabled ? '已启用' : '已停用')
      );
      const actions = element('td', 'cell-actions');
      actions.append(
        actionButton(entry.enabled ? '停用' : '启用', kind, entry.enabled ? 'disable' : 'enable', key),
        actionButton('删除', kind, 'delete', key)
      );
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    host.replaceChildren(table);
  }

  function renderLists() {
    state.actionButtons = [];
    renderTable('fid', state.fids, fidList);
    renderTable('origin', state.origins, originList);
    syncDisabled();
  }

  async function fetchLists() {
    try {
      const response = await fetchJson(API_URL);
      if (!response.ok || !Array.isArray(response.data?.fids) || !Array.isArray(response.data?.origins)) {
        return { ok: false, status: response.status, code: response.data?.error };
      }
      return { ok: true, data: response.data };
    } catch {
      return { ok: false, status: 502, code: 'sso_whitelist_center_unavailable' };
    }
  }

  async function refreshLists({ afterWrite = false } = {}) {
    if (state.busy && !afterWrite) return false;
    if (!afterWrite) state.busy = true;
    syncDisabled();
    if (!afterWrite) setStatus('正在读取认证中心白名单…');
    const result = await fetchLists();
    if (result.ok) {
      state.fids = result.data.fids;
      state.origins = result.data.origins;
      state.loaded = true;
      renderLists();
      setStatus(afterWrite ? '操作已保存并刷新认证中心名单。' : '认证中心白名单已加载。', 'success');
    } else {
      state.loaded = false;
      setStatus(
        afterWrite ? '请求已提交但刷新失败，请刷新确认' : errorMessage(result.status, result.code),
        'error'
      );
    }
    if (!afterWrite) state.busy = false;
    syncDisabled();
    return result.ok;
  }

  async function write(payload, onConfirmed) {
    if (!state.loaded || state.busy) return false;
    state.busy = true;
    syncDisabled();
    setStatus('正在提交认证中心白名单操作…');
    let response;
    try {
      response = await fetchJson(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch {
      response = { ok: false, status: 502, data: { error: 'sso_whitelist_center_unavailable' } };
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        state.loaded = false;
        state.busy = false;
        setStatus(errorMessage(response.status, response.data?.error), 'error');
        syncDisabled();
        return false;
      }
      if (response.status >= 500) {
        const readback = await fetchLists();
        if (readback.ok) {
          state.fids = readback.data.fids;
          state.origins = readback.data.origins;
          state.loaded = true;
          renderLists();
          setStatus('提交结果未确认，已刷新名单，请核对后再操作', 'warn');
        } else {
          state.loaded = false;
          setStatus('提交结果未确认，刷新失败，请刷新确认', 'error');
        }
        state.busy = false;
        syncDisabled();
        return false;
      }
      state.busy = false;
      setStatus(errorMessage(response.status, response.data?.error), 'error');
      syncDisabled();
      return false;
    }

    const refreshed = await refreshLists({ afterWrite: true });
    state.busy = false;
    if (refreshed) onConfirmed?.();
    syncDisabled();
    return refreshed;
  }

  fidForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.loaded || state.busy) return;
    const fid = fidField.input.value.trim();
    const name = fidNameField.input.value.trim();
    if (!/^\d{1,32}$/.test(fid)) {
      setStatus('机构 FID 必须是 1 至 32 位数字。', 'error');
      return;
    }
    await write({ kind: 'fid', action: 'add', fid, name }, () => {
      fidField.input.value = '';
      fidNameField.input.value = '';
    });
  });

  originForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.loaded || state.busy) return;
    const origin = validOrigin(originField.input.value.trim());
    const note = originNoteField.input.value.trim();
    if (!origin) {
      setStatus('请填写不含路径、参数或账号信息的 HTTP(S) Origin。', 'error');
      return;
    }
    await write({ kind: 'origin', action: 'add', origin, note }, () => {
      originField.input.value = '';
      originNoteField.input.value = '';
    });
  });

  refresh.addEventListener('click', () => refreshLists());
  await refreshLists();
  return { refresh: refreshLists };
}
