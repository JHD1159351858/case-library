import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase } from '../../project/backend/database.mjs';

function insertAgent(db, id, updatedAt, overrides = {}) {
  return db.insertAgent({
    id,
    name: `案例${id}`,
    summary: '',
    tags: '',
    status: 'active',
    dataJson: '{}',
    discipline: '工学',
    major: '',
    courseName: '',
    agentUrl: '',
    schoolName: '',
    coverImage: '',
    painPoint: '',
    usageGuide: '',
    createdBy: null,
    createdAt: updatedAt,
    updatedAt,
    ...overrides
  });
}

test('热门位存储：旧 SQLite 库启动时建表，配置可覆盖并跨重启保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featured-storage-'));
  const databasePath = join(dir, 'legacy.db');
  let db;
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE card_effect_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    legacy.close();

    db = createDatabase({ databasePath });
    assert.deepEqual(db.featuredAgentSettings(), { agentIds: [null, null, null], updatedAt: null });
    assert.deepEqual(
      db.saveFeaturedAgentSettings(['agent_a', null, 'agent_c'], 123456),
      { agentIds: ['agent_a', null, 'agent_c'], updatedAt: 123456 }
    );
    db.close();
    db = null;

    db = createDatabase({ databasePath });
    assert.deepEqual(db.featuredAgentSettings(), {
      agentIds: ['agent_a', null, 'agent_c'],
      updatedAt: 123456
    });
    assert.deepEqual(
      db.saveFeaturedAgentSettings([null, null, null], 123457),
      { agentIds: [null, null, null], updatedAt: 123457 }
    );
    db.close();
    db = null;
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('热门位存储：选中案例在筛选和分页前置顶，其余仍按更新时间与 ID 排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'featured-order-'));
  const databasePath = join(dir, 'order.db');
  let db;
  try {
    db = createDatabase({ databasePath });
    insertAgent(db, 'agent_a', 100, { discipline: '理学' });
    insertAgent(db, 'agent_b', 400, { discipline: '工学' });
    insertAgent(db, 'agent_c', 300, { discipline: '理学' });
    insertAgent(db, 'agent_d', 200, { discipline: '工学' });
    db.saveFeaturedAgentSettings(['agent_a', null, 'agent_d'], 500);

    assert.deepEqual(db.listAgents().items.map((item) => item.id), [
      'agent_a', 'agent_d', 'agent_b', 'agent_c'
    ]);
    assert.deepEqual(db.listAgents({ limit: 2, offset: 0 }).items.map((item) => item.id), ['agent_a', 'agent_d']);
    assert.deepEqual(db.listAgents({ limit: 2, offset: 2 }).items.map((item) => item.id), ['agent_b', 'agent_c']);
    assert.deepEqual(db.listAgents({ discipline: '理学' }).items.map((item) => item.id), ['agent_a', 'agent_c']);
    assert.equal(db.listAgents({ discipline: '理学' }).total, 2);
    db.close();
    db = null;
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
