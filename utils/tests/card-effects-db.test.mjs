/** 卡片效果配置持久化测试：真实 SQLite 临时库，不接触生产数据。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createDatabase } from '../../project/backend/database.mjs';
import { DEFAULT_CARD_EFFECT_SETTINGS } from '../../project/frontend/js/card-effect-settings.js';

function withDatabase(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-card-effects-db-'));
  const databasePath = join(dir, 'test.db');
  const db = createDatabase({ databasePath });
  try {
    run(db, databasePath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('卡片效果数据库：未保存不插默认行，配置表只能容纳 id=1', () => {
  withDatabase((db, databasePath) => {
    assert.equal(db.cardEffectSettings(), null);
    const raw = new DatabaseSync(databasePath);
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM card_effect_settings').get().total, 0);
      assert.throws(() => raw.prepare('INSERT INTO card_effect_settings (id, data_json, updated_at) VALUES (?, ?, ?)').run(2, '{}', 100), /CHECK/);
    } finally {
      raw.close();
    }
  });
});

test('卡片效果数据库：重复保存覆盖单行，数据和时间完整回读且不改案例', () => {
  withDatabase((db, databasePath) => {
    db.insertAgent({ id: 'existing', name: '已有案例', summary: '原简介', tags: '', status: 'active', dataJson: '{"original":true}',
      discipline: '工学', major: '', courseName: '', agentUrl: '/agents.html', schoolName: '', coverImage: '', painPoint: '', usageGuide: '',
      createdBy: null, createdAt: 10, updatedAt: 20 });
    const before = db.findAgentById('existing');
    const first = { ...DEFAULT_CARD_EFFECT_SETTINGS, speed: 1 };
    assert.deepEqual(db.saveCardEffectSettings(first, 100), { settings: first, updatedAt: 100 });
    const next = { ...first, flame2: '#123456', opacity: 0.5 };
    assert.deepEqual(db.saveCardEffectSettings(next, 200), { settings: next, updatedAt: 200 });
    assert.deepEqual(db.cardEffectSettings(), { settings: next, updatedAt: 200 });
    assert.deepEqual(db.findAgentById('existing'), before);
    const raw = new DatabaseSync(databasePath);
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM card_effect_settings').get().total, 1);
    } finally {
      raw.close();
    }
  });
});

test('卡片效果数据库：关闭并重启保留配置与时间，幂等建表不覆盖保存内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-card-effects-reopen-'));
  const databasePath = join(dir, 'test.db');
  let db;
  try {
    db = createDatabase({ databasePath });
    const settings = { ...DEFAULT_CARD_EFFECT_SETTINGS, flame1: '#112233', flame2: '#445566', flame3: '#778899', brightness: 1.2 };
    db.saveCardEffectSettings(settings, 123456);
    db.close();
    db = createDatabase({ databasePath });
    assert.deepEqual(db.cardEffectSettings(), { settings, updatedAt: 123456 });
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
