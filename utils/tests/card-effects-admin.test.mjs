import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { CARD_EFFECT_FIELDS, DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings } from '../../project/frontend/js/card-effect-settings.js';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function page(admin = true, fetchJson = async () => ({ ok: true, data: { settings: DEFAULT_CARD_EFFECT_SETTINGS } })) {
  const nodes = new Map();
  const events = new Map();
  const calls = { mounts: 0, disposed: 0, updates: [] };
  function get(id) {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, { hidden: true, value: '', textContent: '', style: {}, dataset: {},
        focus() {}, addEventListener(type, callback) { listeners.set(type, callback); },
        emit(type, event = {}) { return listeners.get(type)?.({ target: this, preventDefault() {}, ...event }); }
      });
    }
    return nodes.get(id);
  }
  function mount() {
    calls.mounts++;
    const dispose = () => calls.disposed++;
    dispose.update = (settings, rank) => calls.updates.push({ settings, rank });
    return dispose;
  }
  const document = { getElementById: get, body: { style: { overflow: 'auto' } },
    addEventListener(type, callback) { events.set(type, callback); } };
  const context = createContext({ document, CARD_EFFECT_FIELDS, DEFAULT_CARD_EFFECT_SETTINGS, normalizeCardEffectSettings,
    mountShaderCard: mount, mountCardTilt: mount, fetchJson });
  const source = readFileSync(new URL('../../project/frontend/js/card-effects-admin.js', import.meta.url), 'utf8');
  runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '') + '\nglobalThis.init = initCardEffects;', context);
  const api = context.init({ isAdmin: () => admin });
  return { api, get, calls, document, events };
}

test('卡片参数弹窗：管理员可打开，关闭释放预览并恢复滚动', async () => {
  const ui = page();
  await ui.api.open();
  await ui.api.open();
  assert.equal(ui.get('card-effects-backdrop').hidden, false);
  assert.equal(ui.document.body.style.overflow, 'hidden');
  assert.equal(ui.calls.mounts, 2);
  ui.api.close();
  ui.api.close();
  assert.equal(ui.calls.disposed, 2);
  assert.equal(ui.document.body.style.overflow, 'auto');
  assert.equal(ui.get('card-effects-backdrop').hidden, true);
  const unauthorized = page(false);
  await unauthorized.api.open();
  assert.equal(unauthorized.calls.mounts, 0);
});

test('卡片参数弹窗：颜色独立、数值同步、切换 TOP 实时更新且不重建', async () => {
  const ui = page();
  await ui.api.open();
  ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'flame2' }, value: '#ABCDEF' } });
  assert.equal(ui.get('effect-flame2').value, '#abcdef');
  assert.equal(ui.get('effect-flame1').value, DEFAULT_CARD_EFFECT_SETTINGS.flame1);
  assert.equal(ui.get('effect-flame3').value, DEFAULT_CARD_EFFECT_SETTINGS.flame3);
  ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'brightness' }, valueAsNumber: 1.2 } });
  assert.equal(ui.get('effect-brightness').value, '1.2');
  assert.equal(ui.get('effect-number-brightness').value, '1.2');
  ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'decaySpeed' }, valueAsNumber: 1.5 } });
  assert.equal(ui.get('effect-decaySpeed').value, '1.5');
  assert.equal(ui.get('effect-number-decaySpeed').value, '1.5');
  ui.get('card-effects-rank').value = '2';
  ui.get('card-effects-rank').emit('change');
  assert.equal(ui.calls.updates.at(-2).rank, 2);
  assert.equal(ui.get('card-effects-preview-rank').textContent, '热门 TOP 2 预览');
  assert.equal(ui.calls.mounts, 2);
  assert.equal(ui.calls.disposed, 0);
});

test('卡片参数弹窗：恢复明亮默认值；Escape 释放画布，重新打开保留调节', async () => {
  const ui = page();
  await ui.api.open();
  ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'opacity' }, valueAsNumber: 0.2 } });
  ui.events.get('keydown')({ key: 'Escape' });
  await ui.api.open();
  assert.equal(ui.get('effect-opacity').value, '0.2');
  ui.get('card-effects-reset').emit('click');
  assert.equal(ui.get('effect-opacity').value, '1');
  assert.equal(ui.get('effect-highlight').value, '1');
  assert.equal(ui.get('effect-brightness').value, '1');
  assert.equal(ui.get('effect-decaySpeed').value, '0');
  assert.equal(ui.calls.mounts, 4);
});

test('卡片配置读取：载入已发布参数，关闭时的迟到响应不重新创建画布', async () => {
  const request = deferred();
  const ui = page(true, () => request.promise);
  const opening = ui.api.open();
  assert.equal(ui.get('card-effects-save').disabled, true);
  ui.api.close();
  request.resolve({ ok: true, data: { settings: { ...DEFAULT_CARD_EFFECT_SETTINGS, flame3: '#112233', opacity: 0.8 } } });
  await opening;
  assert.equal(ui.get('card-effects-backdrop').hidden, true);
  assert.equal(ui.calls.mounts, 2);
  assert.equal(ui.calls.disposed, 2);
  await ui.api.open();
  assert.equal(ui.get('effect-flame3').value, '#112233');
  assert.equal(ui.get('effect-opacity').value, '0.8');
  assert.equal(ui.get('card-effects-save').disabled, false);
});

test('卡片配置读取失败：阻止覆盖全站配置，重试后恢复调节', async () => {
  let attempts = 0;
  const ui = page(true, async () => ++attempts === 1 ? { ok: false, status: 500 }
    : { ok: true, data: { settings: DEFAULT_CARD_EFFECT_SETTINGS } });
  await ui.api.open();
  assert.equal(ui.get('card-effects-save').disabled, true);
  assert.equal(ui.get('card-effects-retry').hidden, false);
  assert.match(ui.get('card-effects-status').textContent, /读取失败/);
  await ui.get('card-effects-retry').emit('click');
  assert.equal(ui.get('card-effects-retry').hidden, true);
  assert.equal(ui.get('card-effects-save').disabled, false);
});

test('卡片配置保存：提交完整三色参数，锁定重复提交和关闭，成功发布', async () => {
  const request = deferred();
  const puts = [];
  const ui = page(true, async (url, options) => {
    assert.equal(url, '/api/card-effects');
    if (!options) return { ok: true, data: { settings: DEFAULT_CARD_EFFECT_SETTINGS } };
    puts.push(options);
    return request.promise;
  });
  await ui.api.open();
  ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'flame2' }, value: '#ABCDEF' } });
  ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'decaySpeed' }, valueAsNumber: 1.5 } });
  const saving = ui.get('card-effects-form').emit('submit');
  await ui.get('card-effects-form').emit('submit');
  ui.api.close();
  assert.equal(ui.get('card-effects-backdrop').hidden, false);
  assert.equal(ui.get('card-effects-close').disabled, true);
  assert.equal(ui.get('effect-flame2').disabled, true);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].method, 'PUT');
  assert.equal(puts[0].headers['Content-Type'], 'application/json');
  const submitted = JSON.parse(puts[0].body).settings;
  assert.equal(Object.keys(submitted).length, 16);
  assert.equal(submitted.decaySpeed, 1.5);
  assert.equal(submitted.flame1, DEFAULT_CARD_EFFECT_SETTINGS.flame1);
  assert.equal(submitted.flame2, '#abcdef');
  assert.equal(submitted.flame3, DEFAULT_CARD_EFFECT_SETTINGS.flame3);
  request.resolve({ ok: true, data: { settings: submitted, updatedAt: 123 } });
  await saving;
  assert.match(ui.get('card-effects-status').textContent, /已保存并应用到全站/);
  assert.equal(ui.get('card-effects-close').disabled, false);
  assert.equal(ui.get('card-effects-save').disabled, false);
});

test('卡片配置保存失败：保留调节，恢复操作并提示管理员权限或网络问题', async () => {
  for (const failure of [401, 500, 'offline']) {
    const ui = page(true, async (_url, options) => {
      if (!options) return { ok: true, data: { settings: DEFAULT_CARD_EFFECT_SETTINGS } };
      if (failure === 'offline') throw new Error('offline');
      return { ok: false, status: failure };
    });
    await ui.api.open();
    ui.get('card-effects-form').emit('input', { target: { dataset: { effectKey: 'brightness' }, valueAsNumber: 1.2 } });
    await ui.get('card-effects-form').emit('submit');
    assert.equal(ui.get('effect-number-brightness').value, '1.2');
    assert.equal(ui.get('card-effects-save').disabled, false);
    assert.match(ui.get('card-effects-status').textContent, failure === 401 ? /管理员登录/ : /保存失败/);
  }
});
