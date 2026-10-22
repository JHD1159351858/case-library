import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const path = new URL('../../project/frontend/js/card-effect-settings.js', import.meta.url);
const context = createContext({});
const source = existsSync(path) ? readFileSync(path, 'utf8') : `
const DEFAULT_CARD_EFFECT_SETTINGS = {};
const CARD_EFFECT_FIELDS = [];
function normalizeCardEffectSettings() { return {}; }
`;
runInContext(source.replace(/\bexport /g, '') + '\nglobalThis.api = { DEFAULT_CARD_EFFECT_SETTINGS, CARD_EFFECT_FIELDS, normalizeCardEffectSettings };', context);
const { DEFAULT_CARD_EFFECT_SETTINGS: defaults, CARD_EFFECT_FIELDS: fields, normalizeCardEffectSettings: normalize } = context.api;
const plain = (value) => JSON.parse(JSON.stringify(value));
const expected = { speed: 0.5, decaySpeed: 0, scale: 4, branch: 2, vext: 1.5, hext: 1.5, radius: 0.9, posy: 0,
  flame1: '#6d2fff', flame2: '#ff4a17', flame3: '#0fae7a', opacity: 1, brightness: 1, highlight: 1, hoverStrength: 0.55, tilt: 8 };

test('卡片参数：冻结默认值及 16 个中文字段定义', () => {
  assert.deepEqual(plain(defaults), expected);
  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(fields), true);
  assert.deepEqual(Array.from(fields, (field) => field.key), Object.keys(expected));
  for (const field of fields) {
    assert.equal(Object.isFrozen(field), true);
    assert.match(field.label, /[\u4e00-\u9fff]/);
    assert.ok(['number', 'color'].includes(field.type));
    if (field.type === 'number') {
      assert.ok(Number.isFinite(field.min) && Number.isFinite(field.max) && field.step > 0);
      assert.ok(expected[field.key] >= field.min && expected[field.key] <= field.max);
    }
  }
});

test('卡片参数：缺失与非法输入回默认，未知键丢弃，不修改输入', () => {
  for (const value of [undefined, null, false, 2, 'text', []]) assert.deepEqual(plain(normalize(value)), expected);
  const input = { brightness: 1.2, unknown: 'discard' };
  const first = normalize(input);
  assert.deepEqual(plain(first), { ...expected, brightness: 1.2 });
  assert.deepEqual(input, { brightness: 1.2, unknown: 'discard' });
  first.speed = 1.5;
  assert.deepEqual(plain(normalize({})), expected);
});

test('卡片参数：有限数字限幅，NaN、Infinity 与类型错误退默认', () => {
  assert.ok(fields.length > 0);
  for (const field of fields.filter((field) => field.type === 'number')) {
    assert.equal(normalize({ [field.key]: field.min - 100 })[field.key], field.min);
    assert.equal(normalize({ [field.key]: field.max + 100 })[field.key], field.max);
    const value = field.min + (field.max - field.min) / 3;
    assert.equal(normalize({ [field.key]: value })[field.key], value);
    for (const invalid of [NaN, Infinity, -Infinity, '1', null, false, {}]) {
      assert.equal(normalize({ [field.key]: invalid })[field.key], expected[field.key]);
    }
  }
});

test('卡片参数：只接受六位颜色值并统一小写', () => {
  for (const key of ['flame1', 'flame2', 'flame3']) {
    assert.equal(normalize({ [key]: '#A1B2C3' })[key], '#a1b2c3');
    for (const invalid of ['#abc', '#aabbccdd', 'aabbcc', 'red', '#zzzzzz', 123, null]) {
      assert.equal(normalize({ [key]: invalid })[key], expected[key]);
    }
  }
});

test('卡片参数：三个排名颜色独立，旧颜色键与未知键丢弃', () => {
  assert.deepEqual(plain(normalize({ flame2: '#123456', flame: '#ffffff', hi: '#ffffff', other: 1 })),
    { ...expected, flame2: '#123456' });
  assert.deepEqual(Array.from(fields.filter((field) => field.type === 'color'), (field) => field.label),
    ['TOP 1 火焰颜色', 'TOP 2 火焰颜色', 'TOP 3 火焰颜色']);
});
