/**
 * 站点交互层（首页最后一幕专属）
 *
 * 两块职责：
 *   1. 「直达最后一幕」按钮：平滑滚动到文档末尾，让 WebGL 时间轴推进到第 4 幕；
 *      接近末尾时按钮自动淡出让位给登录入口。
 *   2. 最后一幕登录区：
 *      - 调 /api/auth/me 获取登录态，未登录显示「登录」入口（跳后端 → 认证中心）
 *      - 已登录显示用户名 +（管理员徽标）+ 退出按钮；退出后联登认证中心
 *      - 识别回调带回的 login=ok / logout=1 / login_error=xx 并给出中文提示
 *      - 未登录时提供「智能体查询平台」入口；管理员额外显示「管理端」入口
 *
 * 依赖：无。所有网络请求同源（后端 2001 托管本页时可用；python 静态预览下
 *       /api 会 404，此时登录区静默降级为「登录服务不可用」）。
 */

const SKIP_FADE_START = 0.9; // 滚动进度超过此值后隐藏「直达最后一幕」按钮

/* ---------------- 工具 ---------------- */

const $ = (id) => document.getElementById(id);

async function fetchJson(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

/** 登录错误码 → 中文提示 */
const LOGIN_ERROR_TEXT = {
  missing_ticket: '登录回调缺少票据，请重新发起登录。',
  invalid_secret: '本站与认证中心的密钥不一致，请联系管理员核对 SSO_SHARED_SECRET。',
  invalid_ticket: '登录票据无效或已被使用，请重新发起登录。',
  ticket_used: '该登录票据已被使用（一次性票据，不可重复验票），请重新发起登录。',
  ticket_expired: '登录票据已过期（有效期 120 秒），请重新发起登录。',
  invalid_identity: '认证中心返回的身份信息不完整，无法建立会话。',
  session_failed: '建立本站会话失败，请稍后重试。',
  verify_failed: '与认证中心通讯失败，请稍后重试。',
  sso_not_configured: '本站尚未配置统一认证中心，登录暂不可用。'
};

/* ---------------- 直达最后一幕 ---------------- */

function initSkipButton() {
  const button = $('skip-to-finale');
  if (!button) return;

  button.addEventListener('click', () => {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: total, behavior: 'smooth' });
    button.blur();
  });

  const update = () => {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const progress = total > 0 ? window.scrollY / total : 0;
    button.classList.toggle('is-hidden', progress >= SKIP_FADE_START);
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

/* ---------------- 最后一幕登录区 ---------------- */

function initFinaleDock() {
  const dock = $('finale-dock');
  if (!dock) return;

  const loginLink = $('finale-login');
  const userBox = $('finale-user');
  const userName = $('finale-user-name');
  const userBadge = $('finale-user-badge');
  const logoutButton = $('finale-logout');
  const status = $('finale-status');

  /** 平台入口链接（未登录：查询平台；管理员：额外管理端） */
  function renderEntries(user) {
    let entries = dock.querySelector('.finale-entries');
    if (!entries) {
      entries = document.createElement('div');
      entries.className = 'finale-entries';
      dock.appendChild(entries);
    }
    entries.innerHTML = '';
    const links = [{ href: '/agents.html', label: '智能体查询平台' }];
    if (user?.isAdmin) links.push({ href: '/admin.html', label: '管理端' });
    for (const link of links) {
      const anchor = document.createElement('a');
      anchor.className = 'finale-entry';
      anchor.href = link.href;
      anchor.textContent = link.label;
      entries.appendChild(anchor);
    }
  }

  function setStatus(message, tone = '') {
    status.textContent = message ?? '';
    status.dataset.tone = tone;
  }

  function renderLoggedOut(message, tone) {
    dock.dataset.authState = 'anonymous';
    loginLink.hidden = false;
    userBox.hidden = true;
    renderEntries(null);
    setStatus(message, tone);
  }

  function renderLoggedIn(user) {
    dock.dataset.authState = 'authenticated';
    loginLink.hidden = true;
    userBox.hidden = false;
    userName.textContent = user.displayName || user.name || '已登录';
    userBadge.hidden = !user.isAdmin;
    renderEntries(user);
  }

  /** 读取回调参数：login=ok / logout=1 / login_error=xx */
  function consumeCallbackParams() {
    const params = new URLSearchParams(window.location.search);
    const login = params.get('login');
    const logout = params.get('logout');
    const error = params.get('login_error');
    if (!login && !logout && !error) return { message: '', tone: '' };

    let tone = '';
    let message = '';
    if (error) {
      tone = 'error';
      message = LOGIN_ERROR_TEXT[error] ?? `登录失败（${error}）。`;
    } else if (login === 'ok') {
      tone = 'success';
      message = '登录成功，欢迎回来。';
    } else if (logout === '1') {
      tone = 'success';
      message = '已退出登录。';
    }

    // 清理地址栏参数，避免刷新时重复提示
    params.delete('login');
    params.delete('logout');
    params.delete('login_error');
    const query = params.toString();
    const clean = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', clean);
    return { message, tone };
  }

  logoutButton?.addEventListener('click', async () => {
    logoutButton.disabled = true;
    setStatus('正在退出…');
    try {
      const { data } = await fetchJson('/api/auth/logout', { method: 'POST' });
      renderLoggedOut('已退出本站登录。');
      // 认证中心侧的会话同样需要清理，否则下次登录会直接免密通过
      if (data?.logoutUrl) {
        window.location.href = data.logoutUrl;
        return;
      }
      await refresh();
    } catch {
      renderLoggedOut('退出请求失败，请稍后重试。', 'error');
    } finally {
      logoutButton.disabled = false;
    }
  });

  async function refresh() {
    const callback = consumeCallbackParams();
    try {
      const { ok, data } = await fetchJson('/api/auth/me');
      if (!ok || !data) throw new Error(`status ${'unknown'}`);
      if (data.user) renderLoggedIn(data.user);
      else renderLoggedOut(callback.message || '登录后可保存与管理智能体数据。', callback.tone);
      if (callback.message && data.user) setStatus(callback.message, callback.tone);
      if (!data.ssoEnabled && !data.user) setStatus('本站尚未配置统一认证中心，登录暂不可用。', 'error');
    } catch {
      // python 静态预览（无后端）或后端未启动：降级为静态提示，不报错
      renderLoggedOut('未连接后端服务，登录与查询平台需通过 http://127.0.0.1:2001/ 访问。', 'error');
    }
  }

  refresh();
}

/* ---------------- 启动 ---------------- */

initSkipButton();
initFinaleDock();
