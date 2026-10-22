import { escapeHtml, fetchJson, renderAgentLink, resolveAgentLink } from './session.js';

const $ = (id) => document.getElementById(id);

/** 对话入口只调用本站接口；未接入 AI 时明确提示，不生成模拟推荐。 */
export function initAgentChat({ openDetail }) {
  const messages = [];
  let busy = false;
  let requestId = 0;
  let controller;
  let previousOverflow = '';

  function render(pending = '') {
    const entries = pending ? [...messages, { role: 'user', content: pending }] : messages;
    const log = $('agent-chat-messages');
    log.innerHTML = entries.map((message) => `
      <div class="agent-chat-message" data-role="${message.role}">
        <strong>${message.role === 'user' ? '你' : '推荐助手'}</strong>
        <p>${escapeHtml(message.content)}</p>
        ${(message.items || []).map((item) => {
          const link = resolveAgentLink(item.agentUrl);
          const scored = Number.isInteger(item.matchScore) && item.matchScore >= 0 && item.matchScore <= 100;
          const reason = typeof item.matchReason === 'string' ? item.matchReason.trim() : '';
          return `<button class="btn btn-ghost agent-chat-case" type="button" data-chat-agent-id="${escapeHtml(item.id)}" title="查看完整详情">${escapeHtml(item.name)}${scored ? `<span class="agent-chat-match-score">匹配度 ${item.matchScore}%</span>` : ''}<span>${escapeHtml([item.major, item.schoolName].filter(Boolean).join(' · '))}</span></button>
            ${reason ? `<p class="agent-chat-match-reason">${escapeHtml(reason)}</p>` : ''}
            ${link ? renderAgentLink(link) : '<span class="field-hint">暂无可用链接</span>'}`;
        }).join('')}
      </div>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(value) {
    busy = value;
    $('agent-chat-send').disabled = value;
    $('agent-chat-input').disabled = value;
  }

  function open() {
    if (!$('agent-chat-backdrop').hidden) return;
    previousOverflow = document.body.style.overflow;
    $('agent-chat-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    render();
    $('agent-chat-input').focus();
  }

  function close() {
    if ($('agent-chat-backdrop').hidden) return;
    if (busy) $('agent-chat-status').textContent = '查询已取消，你的需求已保留。';
    ++requestId;
    controller?.abort();
    controller = null;
    setBusy(false);
    $('agent-chat-backdrop').hidden = true;
    document.body.style.overflow = previousOverflow;
    $('agent-chat-open').focus();
  }

  async function submit(event) {
    event.preventDefault();
    const input = $('agent-chat-input');
    const content = input.value.trim();
    if (busy || !content) return;
    if (content.length > 2000) {
      $('agent-chat-status').textContent = '请将需求控制在 2000 字以内。';
      return;
    }
    const current = ++requestId;
    controller = new AbortController();
    setBusy(true);
    render(content);
    $('agent-chat-status').textContent = '正在查找…';
    try {
      const { ok, data } = await fetchJson('/api/agents/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ messages: [...messages.slice(-18).map(({ role, content }) => ({ role, content })), { role: 'user', content }] })
      });
      if (current !== requestId) return;
      if (!ok) {
        if (data?.error === 'ai_not_configured') $('agent-chat-availability').textContent = 'AI 尚未接入，目前请使用页面上的关键词搜索。';
        $('agent-chat-status').textContent = data?.error === 'ai_not_configured'
          ? 'AI 尚未接入，请先使用关键词搜索。你的需求已保留，可稍后重试。'
          : '暂时无法获取推荐，请稍后重试。你的需求已保留。';
        render();
        return;
      }
      if (typeof data?.reply !== 'string' || !Array.isArray(data.items)) throw new Error('invalid_reply');
      messages.push({ role: 'user', content }, { role: 'assistant', content: data.reply, items: data.items });
      $('agent-chat-availability').textContent = '可以继续补充需求，或打开推荐的智能体。匹配度为 AI 参考评分，反映当前需求与案例信息的匹配程度。';
      if (messages.length > 20) messages.splice(0, messages.length - 20);
      input.value = '';
      $('agent-chat-status').textContent = data.items.length ? '点击“打开智能体”访问网址，或点击案例名称查看详情。' : '没有匹配案例，可以补充需求继续对话。';
      render();
    } catch {
      if (current !== requestId) return;
      $('agent-chat-status').textContent = '连接失败，请稍后重试。你的需求已保留。';
      render();
    } finally {
      if (current === requestId) {
        controller = null;
        setBusy(false);
      }
    }
  }

  $('agent-chat-open').addEventListener('click', open);
  $('agent-chat-close').addEventListener('click', close);
  $('agent-chat-form').addEventListener('submit', submit);
  $('agent-chat-messages').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-chat-agent-id]');
    if (!button) return;
    const item = messages.flatMap((message) => message.items || []).find((candidate) => candidate.id === button.dataset.chatAgentId);
    if (!item) return;
    close();
    openDetail(item.id, item);
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  return { open, close, submit };
}
