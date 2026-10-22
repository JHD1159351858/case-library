import { CARD_EFFECT_FIELDS, DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings } from './card-effect-settings.js';
import { mountCardTilt, mountShaderCard } from './shader-card.js';
import { fetchJson } from './session.js';

const $ = (id) => document.getElementById(id);

/** 管理端效果预览；参数更新复用现有画布。 */
export function initCardEffects({ isAdmin }) {
  let settings = normalizeCardEffectSettings(DEFAULT_CARD_EFFECT_SETTINGS);
  let rank = 1;
  let shader;
  let tilt;
  let previousOverflow = '';
  let loaded = false;
  let loading;
  let saving = false;
  const groups = [
    ['颜色与明暗', (field) => field.type === 'color' || ['opacity', 'brightness', 'highlight'].includes(field.key)],
    ['流体形态', (field) => ['speed', 'decaySpeed', 'scale', 'branch', 'vext', 'hext', 'radius', 'posy'].includes(field.key)],
    ['鼠标交互', (field) => ['hoverStrength', 'tilt'].includes(field.key)]
  ];
  $('card-effects-controls').innerHTML = groups.map(([title, includes]) => `
    <p class="section-label">${title}</p>
    <div class="card-effects-control-group">${CARD_EFFECT_FIELDS.filter(includes).map((field) => `
      <div class="card-effects-control">
        <label for="effect-${field.key}">${field.label}</label>
        <div class="card-effects-control-inputs">
          ${field.type === 'color'
            ? `<input class="input" id="effect-${field.key}" type="color" data-effect-key="${field.key}" /><code id="effect-value-${field.key}"></code>`
            : `<input id="effect-${field.key}" type="range" min="${field.min}" max="${field.max}" step="${field.step}" data-effect-key="${field.key}" />
               <input class="input" id="effect-number-${field.key}" type="number" min="${field.min}" max="${field.max}" step="${field.step}" data-effect-key="${field.key}" aria-label="${field.label}数值" />`}
        </div>
        ${field.key === 'decaySpeed' ? '<p class="field-hint">值越大，上升火焰越快淡出；0 保留原始效果。</p>' : ''}
      </div>`).join('')}</div>`).join('');

  function writeControls() {
    for (const field of CARD_EFFECT_FIELDS) {
      $(`effect-${field.key}`).value = String(settings[field.key]);
      if (field.type === 'color') $(`effect-value-${field.key}`).textContent = settings[field.key];
      else $(`effect-number-${field.key}`).value = String(settings[field.key]);
    }
  }

  function updatePreview() {
    shader?.update(settings, rank);
    tilt?.update(settings);
    $('card-effects-preview-rank').textContent = `热门 TOP ${rank} 预览`;
  }

  function updateDisabled() {
    const disabled = !loaded || Boolean(loading) || saving;
    for (const field of CARD_EFFECT_FIELDS) {
      $(`effect-${field.key}`).disabled = disabled;
      if (field.type === 'number') $(`effect-number-${field.key}`).disabled = disabled;
    }
    $('card-effects-save').disabled = disabled;
    $('card-effects-reset').disabled = disabled;
    $('card-effects-rank').disabled = disabled;
    $('card-effects-close').disabled = saving;
  }

  async function loadSettings() {
    if (loading) return loading;
    $('card-effects-retry').hidden = true;
    $('card-effects-status').textContent = '正在读取全站效果配置…';
    loading = (async () => {
      try {
        const { ok, data } = await fetchJson('/api/card-effects');
        if (!ok || !data?.settings) throw new Error('load_failed');
        settings = normalizeCardEffectSettings(data.settings);
        loaded = true;
        writeControls();
        updatePreview();
        $('card-effects-status').textContent = '调节后点击“保存并应用”，新打开或刷新的查询页将使用此配置。';
      } catch {
        $('card-effects-status').textContent = '配置读取失败，请重试。';
        $('card-effects-retry').hidden = false;
      } finally {
        loading = null;
        updateDisabled();
      }
    })();
    updateDisabled();
    return loading;
  }

  async function open() {
    if (!isAdmin() || !$('card-effects-backdrop').hidden) return;
    previousOverflow = document.body.style.overflow;
    $('card-effects-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    writeControls();
    shader = mountShaderCard($('card-effects-preview-card'), settings, rank);
    tilt = mountCardTilt($('card-effects-preview-card'), settings);
    $('card-effects-close').focus();
    if (!loaded) await loadSettings();
  }

  function close() {
    if (saving) return;
    if (!$('card-effects-backdrop').hidden) {
      $('card-effects-backdrop').hidden = true;
      document.body.style.overflow = previousOverflow;
      shader?.();
      tilt?.();
      shader = tilt = null;
      $('card-effects-open').focus();
    }
  }

  $('card-effects-open').addEventListener('click', open);
  $('card-effects-close').addEventListener('click', close);
  $('card-effects-retry').addEventListener('click', loadSettings);
  $('card-effects-form').addEventListener('input', (event) => {
    if (!loaded || saving || loading) return;
    const key = event.target.dataset.effectKey;
    const field = CARD_EFFECT_FIELDS.find((item) => item.key === key);
    if (!field) return;
    settings = normalizeCardEffectSettings({ ...settings, [key]: field.type === 'color' ? event.target.value : event.target.valueAsNumber });
    writeControls();
    updatePreview();
    $('card-effects-status').textContent = '正在实时预览，尚未发布。点击“保存并应用”对全站生效。';
  });
  $('card-effects-rank').addEventListener('change', (event) => {
    rank = Number(event.target.value);
    updatePreview();
  });
  $('card-effects-reset').addEventListener('click', () => {
    if (!loaded || saving || loading) return;
    settings = normalizeCardEffectSettings(DEFAULT_CARD_EFFECT_SETTINGS);
    writeControls();
    updatePreview();
    $('card-effects-status').textContent = '已恢复明亮的默认预览，点击“保存并应用”发布。';
  });
  $('card-effects-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isAdmin() || !loaded || saving || loading) return;
    saving = true;
    updateDisabled();
    $('card-effects-status').textContent = '正在保存…';
    try {
      const { ok, status, data } = await fetchJson('/api/card-effects', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings })
      });
      if (!ok || !data?.settings) {
        $('card-effects-status').textContent = status === 401 || status === 403
          ? '保存失败，请确认管理员登录状态。当前调节已保留。'
          : '保存失败，请重试。当前调节已保留。';
        return;
      }
      settings = normalizeCardEffectSettings(data.settings);
      writeControls();
      updatePreview();
      $('card-effects-status').textContent = '已保存并应用到全站。新打开或刷新的查询页将使用此配置。';
    } catch {
      $('card-effects-status').textContent = '保存失败，请检查网络后重试。当前调节已保留。';
    } finally {
      saving = false;
      updateDisabled();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  return { open, close };
}
