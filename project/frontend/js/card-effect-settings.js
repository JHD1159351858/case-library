export const DEFAULT_CARD_EFFECT_SETTINGS = Object.freeze({
  speed: 0.5, decaySpeed: 0, scale: 4, branch: 2, vext: 1.5, hext: 1.5, radius: 0.9, posy: 0,
  flame1: '#6d2fff', flame2: '#ff4a17', flame3: '#0fae7a', opacity: 1, brightness: 1, highlight: 1, hoverStrength: 0.55, tilt: 8
});

export const CARD_EFFECT_FIELDS = Object.freeze([
  { key: 'speed', label: '流动速度', type: 'number', min: 0, max: 2, step: 0.01 },
  { key: 'decaySpeed', label: '消散速度', type: 'number', min: 0, max: 3, step: 0.05 },
  { key: 'scale', label: '纹理尺度', type: 'number', min: 1, max: 8, step: 0.1 },
  { key: 'branch', label: '脉络强度', type: 'number', min: 0, max: 4, step: 0.05 },
  { key: 'vext', label: '纵向范围', type: 'number', min: 0.5, max: 2.5, step: 0.05 },
  { key: 'hext', label: '横向范围', type: 'number', min: 0.5, max: 2.5, step: 0.05 },
  { key: 'radius', label: '鼠标影响范围', type: 'number', min: 0.2, max: 1.6, step: 0.05 },
  { key: 'posy', label: '垂直位置', type: 'number', min: -1, max: 1, step: 0.01 },
  { key: 'flame1', label: 'TOP 1 火焰颜色', type: 'color' },
  { key: 'flame2', label: 'TOP 2 火焰颜色', type: 'color' },
  { key: 'flame3', label: 'TOP 3 火焰颜色', type: 'color' },
  { key: 'opacity', label: '画布透明度', type: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'brightness', label: '整体亮度', type: 'number', min: 0.5, max: 1.5, step: 0.01 },
  { key: 'highlight', label: '高光强度', type: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'hoverStrength', label: '鼠标拉动强度', type: 'number', min: 0, max: 1, step: 0.01 },
  { key: 'tilt', label: '摆动角度', type: 'number', min: 0, max: 15, step: 0.5 }
].map((field) => Object.freeze(field)));

/** 只保留已知参数；非法值恢复默认，有限数字限幅，颜色统一为六位小写。 */
export function normalizeCardEffectSettings(input = {}) {
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const settings = {};
  for (const field of CARD_EFFECT_FIELDS) {
    const value = values[field.key];
    settings[field.key] = DEFAULT_CARD_EFFECT_SETTINGS[field.key];
    if (field.type === 'color') {
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) settings[field.key] = value.toLowerCase();
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      settings[field.key] = Math.max(field.min, Math.min(field.max, value));
    }
  }
  return settings;
}
