/** 认证中心白名单适配器：固定接口、独立密钥、无写重试。 */
export class SsoWhitelistError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const invalidInput = () => new SsoWhitelistError(400, 'sso_whitelist_invalid_input');
const unavailable = () => new SsoWhitelistError(502, 'sso_whitelist_center_unavailable');

function normalizeCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !['fid', 'origin'].includes(input.kind)
    || !['add', 'enable', 'disable', 'delete'].includes(input.action)) throw invalidInput();
  const { kind, action } = input;
  const labelKey = kind === 'fid' ? 'name' : 'note';
  if (Object.keys(input).some(key => !['kind', 'action', kind, labelKey].includes(key))) throw invalidInput();
  const key = input[kind];
  const label = input[labelKey] ?? '';
  if (typeof key !== 'string' || typeof label !== 'string' || label.length > 200) throw invalidInput();
  if (kind === 'fid') {
    if (!/^\d{1,32}$/.test(key.trim())) throw invalidInput();
    return { kind, action, fid: key.trim(), name: label.trim() };
  }
  let url;
  try { url = new URL(key.trim()); } catch { throw invalidInput(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw invalidInput();
  return { kind, action, origin: url.origin, note: label.trim() };
}

export function createSsoWhitelistClient({ centerUrl, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  let base;
  try { base = new URL(centerUrl); } catch { throw new SsoWhitelistError(503, 'sso_whitelist_not_configured'); }
  const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !localHttp) || base.username || base.password
    || !/^[\x21-\x7e]{32,}$/.test(token ?? '')) {
    throw new SsoWhitelistError(503, 'sso_whitelist_not_configured');
  }

  async function call(path, actor, { method = 'GET', body } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    let data;
    try {
      response = await fetchImpl(`${base.origin}${path}`, {
        method,
        headers: {
          accept: 'application/json', authorization: `Bearer ${token}`,
          'x-case-library-actor': encodeURIComponent(actor),
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', cache: 'no-store', signal
      });
      if (response.ok) data = await response.json();
    } catch (error) {
      if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new SsoWhitelistError(504, 'sso_whitelist_center_timeout');
      }
      throw unavailable();
    }
    if (response.status === 401 || response.status === 403) {
      throw new SsoWhitelistError(502, 'sso_whitelist_center_unauthorized');
    }
    if (!response.ok) {
      if (response.status === 400) throw invalidInput();
      if (method !== 'GET' && response.status === 404) throw new SsoWhitelistError(404, 'sso_whitelist_not_found');
      if (response.status === 409) throw new SsoWhitelistError(409, 'sso_whitelist_conflict');
      throw unavailable();
    }
    if (data?.ok !== true) throw unavailable();
    return data;
  }

  return {
    async read(actor) {
      const [fids, origins] = await Promise.all([
        call('/api/admin/fids', actor), call('/api/admin/origins', actor)
      ]);
      if (!Array.isArray(fids.items) || !Array.isArray(origins.items)
        || fids.items.some(item => !item || typeof item.fid !== 'string' || typeof item.name !== 'string' || typeof item.enabled !== 'boolean')
        || origins.items.some(item => !item || typeof item.origin !== 'string' || typeof item.note !== 'string' || typeof item.enabled !== 'boolean')) throw unavailable();
      return {
        fids: fids.items.map(({ fid, name, enabled }) => ({ fid, name, enabled })),
        origins: origins.items.map(({ origin, note, enabled }) => ({ origin, note, enabled }))
      };
    },
    async write(input, actor) {
      const command = normalizeCommand(input);
      const { kind, action } = command;
      if (kind === 'fid') {
        const path = action === 'add' ? '/api/admin/fids' : `/api/admin/fids/${encodeURIComponent(command.fid)}`;
        const method = action === 'add' ? 'POST' : action === 'delete' ? 'DELETE' : 'PATCH';
        const body = action === 'add' ? { fid: command.fid, name: command.name }
          : action === 'delete' ? undefined : { enabled: action === 'enable' };
        await call(path, actor, { method, body });
      } else {
        const path = action === 'add' ? '/api/admin/origins' : '/api/admin/origins/action';
        const body = action === 'add' ? { origin: command.origin, note: command.note }
          : action === 'delete' ? { origin: command.origin, delete: true }
            : { origin: command.origin, enabled: action === 'enable' };
        await call(path, actor, { method: 'POST', body });
      }
      return { ok: true };
    }
  };
}
