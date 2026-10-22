/**
 * 会话与通用工具（应用页共享模块）
 *
 * 提供：
 *   - fetchJson：同源 JSON 请求封装（带 Cookie）
 *   - loadSession / renderSessionChip：读取 /api/auth/me，渲染顶栏会话区
 *   - logout：退出本站会话并联动清理认证中心会话
 *   - toast / escapeHtml / formatTime：轻量 UI 工具
 *   - resolveAgentLink / renderAgentLink：智能体链接归一与详情链接块渲染
 *
 * 降级：后端不可用时（例如以 python 静态服务打开），所有请求失败被捕获，
 *       顶栏显示「未连接后端」提示，页面其余部分仍可浏览静态内容。
 */

const $ = (id) => document.getElementById(id);

export async function fetchJson(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

/* ---------------- 演示数据（后端不可用时的兜底，保持页面可读） ---------------- */

export const DEMO_AGENTS = [
  {
    id: 'demo_case_01',
    name: '课程知识问答智能体',
    summary: '面向在线课程的知识问答助手，依据课程资料回答学生提问，并给出引用出处。',
    tags: '问答,课程,知识库',
    status: 'active',
    discipline: '工学',
    major: '计算机科学与技术',
    courseName: '数据结构与算法',
    schoolName: '示例大学',
    agentUrl: '',
    coverImage: '',
    painPoint: '学生提问集中在课后，教师答疑压力大且回复不及时。',
    usageGuide: '在课程页右侧入口打开，输入问题即可获得带引用的回答。',
    updatedAt: Date.parse('2026-08-20T09:12:00Z'),
    data: { 场景: '课程答疑', 能力: '检索增强问答 / 引用溯源', 负责人: '教学资源中心' }
  },
  {
    id: 'demo_case_02',
    name: '作业批改辅助智能体',
    summary: '对主观题作答给出评分建议与改进意见，辅助教师完成批量批改。',
    tags: '批改,评分,教师工具',
    status: 'active',
    discipline: '教育学',
    major: '教育技术学',
    courseName: '教学评价方法',
    schoolName: '示例大学',
    agentUrl: '',
    coverImage: '',
    painPoint: '主观题批改耗时长，评分标准难以保持前后一致。',
    usageGuide: '上传作答文件并选择评分维度，系统批量输出评分建议。',
    updatedAt: Date.parse('2026-08-22T14:40:00Z'),
    data: { 场景: '作业批改', 能力: '评分建议 / 反馈生成', 负责人: '教务支持组' }
  },
  {
    id: 'demo_case_03',
    name: '学习路径规划智能体',
    summary: '结合学习目标与已修课程，生成分阶段学习路径与资源推荐。',
    tags: '规划,推荐,学习路径',
    status: 'active',
    discipline: '工学',
    major: '软件工程',
    courseName: '专业导论',
    schoolName: '示例理工学院',
    agentUrl: '',
    coverImage: '',
    painPoint: '学生不清楚课程之间的前后依赖，选课与自学安排盲目。',
    usageGuide: '填写目标岗位与已修课程，生成分学期学习路径。',
    updatedAt: Date.parse('2026-08-25T08:05:00Z'),
    data: { 场景: '学习规划', 能力: '路径生成 / 资源匹配', 负责人: '学生发展中心' }
  },
  {
    id: 'demo_case_04',
    name: '课堂互动分析智能体',
    summary: '汇总课堂互动数据，识别参与度变化并输出教学改进建议。',
    tags: '分析,课堂,教学改进',
    status: 'inactive',
    discipline: '理学',
    major: '统计学',
    courseName: '教育统计',
    schoolName: '示例理工学院',
    agentUrl: '',
    coverImage: '',
    painPoint: '课堂互动数据分散在多个平台，教师难以及时发现参与度异常。',
    usageGuide: '接入课堂数据后查看参与度趋势与改进建议清单。',
    updatedAt: Date.parse('2026-08-27T16:30:00Z'),
    data: { 场景: '教学分析', 能力: '数据汇总 / 趋势识别', 负责人: '质量评估组' }
  }
];

/* ---------------- 会话 ---------------- */

/**
 * 读取登录态
 * @returns {Promise<{ user:object|null, ssoEnabled:boolean, backendReady:boolean }>}
 */
export async function loadSession() {
  try {
    const { ok, data } = await fetchJson('/api/auth/me');
    if (!ok || !data) return { user: null, ssoEnabled: false, backendReady: false };
    return { user: data.user ?? null, ssoEnabled: Boolean(data.ssoEnabled), backendReady: true };
  } catch {
    return { user: null, ssoEnabled: false, backendReady: false };
  }
}

/** 顶栏会话区渲染（登录入口 / 用户名 + 徽标 + 退出） */
export function renderSessionChip(container, session, { onChange } = {}) {
  if (!container) return;
  container.innerHTML = '';

  if (!session.backendReady) {
    const chip = document.createElement('div');
    chip.className = 'session-chip';
    chip.innerHTML = '<strong>未连接后端</strong>';
    chip.title = '请通过 http://127.0.0.1:2001/ 访问以启用登录与数据接口';
    container.appendChild(chip);
    return;
  }

  if (!session.user) {
    const chip = document.createElement('div');
    chip.className = 'session-chip';
    chip.innerHTML = '<span>未登录</span>';
    container.appendChild(chip);

    const login = document.createElement('a');
    login.className = 'btn btn-primary btn-sm';
    login.href = '/api/auth/chaoxing/start';
    login.textContent = '登录';
    if (!session.ssoEnabled) {
      login.title = '本站尚未配置统一认证中心';
    }
    container.appendChild(login);
    return;
  }

  const user = session.user;
  const chip = document.createElement('div');
  chip.className = 'session-chip';
  const name = document.createElement('strong');
  name.textContent = user.displayName || user.name || '已登录';
  chip.appendChild(name);
  if (user.isAdmin) {
    const badge = document.createElement('span');
    badge.className = 'session-badge';
    badge.textContent = '管理员';
    chip.appendChild(badge);
  }
  container.appendChild(chip);

  const logout = document.createElement('button');
  logout.className = 'btn btn-ghost btn-sm';
  logout.type = 'button';
  logout.textContent = '退出';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    logout.textContent = '退出中…';
    const { data } = await fetchJson('/api/auth/logout', { method: 'POST' });
    if (data?.logoutUrl) {
      window.location.href = data.logoutUrl;
      return;
    }
    logout.disabled = false;
    logout.textContent = '退出';
    await onChange?.();
  });
  container.appendChild(logout);
}

/* ---------------- 登录 / 退出回调提示 ---------------- */

/** 登录错误码 → 中文提示（与首页 site-ui.js 保持一致） */
const AUTH_ERROR_TEXT = {
  missing_ticket: '登录回调缺少票据，请重新发起登录。',
  invalid_secret: '本站与认证中心的密钥不一致，请联系管理员核对 SSO_SHARED_SECRET。',
  invalid_ticket: '登录票据无效或已被使用，请重新发起登录。',
  ticket_used: '该登录票据已被使用（一次性票据），请重新发起登录。',
  ticket_expired: '登录票据已过期（有效期 120 秒），请重新发起登录。',
  invalid_identity: '认证中心返回的身份信息不完整，无法建立会话。',
  session_failed: '建立本站会话失败，请稍后重试。',
  verify_failed: '与认证中心通讯失败，请稍后重试。',
  sso_not_configured: '本站尚未配置统一认证中心，登录暂不可用。'
};

/**
 * 消费登录 / 退出回调参数（login=ok / logout=1 / login_error=xx）
 *
 * 登录成功与角色分流由后端完成（管理员 → admin.html，普通用户 → agents.html），
 * 本函数只负责把结果转成提示文案，并清理地址栏参数避免刷新时重复提示。
 *
 * @returns {{ message: string, tone: string }}
 */
export function consumeAuthNotice() {
  const params = new URLSearchParams(window.location.search);
  const login = params.get('login');
  const logout = params.get('logout');
  const error = params.get('login_error');
  if (!login && !logout && !error) return { message: '', tone: '' };

  let message = '';
  let tone = '';
  if (error) {
    tone = 'error';
    message = AUTH_ERROR_TEXT[error] ?? `登录失败（${error}）。`;
  } else if (login === 'ok') {
    tone = 'success';
    message = '登录成功，欢迎回来。';
  } else if (logout === '1') {
    tone = 'success';
    message = '已退出登录。';
  }

  for (const key of ['login', 'logout', 'login_error']) params.delete(key);
  const query = params.toString();
  const clean = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', clean);
  return { message, tone };
}

/* ---------------- UI 工具 ---------------- */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toast(message, tone = 'success') {
  const stack = $('toast-stack');
  if (!stack) return;
  const item = document.createElement('div');
  item.className = 'toast';
  item.dataset.tone = tone;
  item.textContent = message;
  stack.appendChild(item);
  window.setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(8px)';
    item.style.transition = 'opacity 240ms ease, transform 240ms ease';
    window.setTimeout(() => item.remove(), 280);
  }, 3200);
}

export function parseTags(value) {
  if (!value) return [];
  return String(value)
    .split(/[,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/* ---------------- 智能体链接 ---------------- */

/**
 * 智能体链接归一（与后端 normalizeAgentUrl 同规则，前端再兜一层）：
 *   站内相对路径（/xxx，非 //）或 http(s) 绝对地址放行；
 *   空值返回 null；javascript: / data: / 协议相对地址等一律视为无效，不渲染成链接。
 * @returns {{ href:string, external:boolean }|null}
 */
export function resolveAgentLink(value) {
  const raw = String(value ?? '');
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  const text = raw.trim();
  if (!text) return null;
  const relative = text.startsWith('/') && !text.startsWith('//');
  if (!relative && !/^https?:\/\//i.test(text)) return null;
  try {
    const base = 'https://agent-site.invalid';
    const url = new URL(text, base);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    if (relative && url.origin !== base) return null;
    return { href: text, external: !relative };
  } catch {
    return null;
  }
}

/**
 * 详情弹窗内的智能体链接块（可识别样式 + 新标签跳转 + noopener 安全属性）
 * @param {{ href:string, external:boolean }} link resolveAgentLink 的结果
 */
export function renderAgentLink(link) {
  if (!link) return '';
  return `<div class="detail-link">
      <a class="detail-link-btn" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">打开智能体
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h-3v9h9v-3" /><path d="M9.5 3.5h3v3" /><path d="M12.5 3.5 7.5 8.5" /></svg>
      </a>
      <span class="detail-link-url mono">${escapeHtml(link.href)}</span>
    </div>`;
}
