import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase } from '../../project/backend/database.mjs';
import { createPgStorage } from '../../project/backend/pg-storage.mjs';
import { PgClient } from '../../project/backend/pg-wire.mjs';

function agentRecord(id, updatedAt, overrides = {}) {
  return {
    id, name: `案例${id}`, summary: '', tags: '', status: 'active', dataJson: '{}',
    discipline: '工学', major: '', courseName: '', agentUrl: '', schoolName: '',
    coverImage: '', painPoint: '', usageGuide: '', createdBy: null, createdAt: updatedAt, updatedAt,
    ...overrides
  };
}

test('案例排序存储：旧库自动建表，顺序原子覆盖且重启后保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-order-legacy-'));
  const databasePath = join(dir, 'legacy.db');
  let db;
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY) STRICT;');
    legacy.close();
    db = createDatabase({ databasePath, now: () => 300 });
    assert.deepEqual(db.agentOrderSettings(), { agentIds: [], updatedAt: null });
    assert.deepEqual(db.saveAgentOrderSettings(['c', 'a', 'b'], 100), {
      agentIds: ['c', 'a', 'b'], updatedAt: 100
    });
    db.close();
    db = null;
    db = createDatabase({ databasePath, now: () => 300 });
    assert.deepEqual(db.agentOrderSettings(), { agentIds: ['c', 'a', 'b'], updatedAt: 100 });
    assert.deepEqual(db.saveAgentOrderSettings(['b', 'c', 'a']), {
      agentIds: ['b', 'c', 'a'], updatedAt: 300
    });
    db.close();
    db = null;
    db = createDatabase({ databasePath });
    assert.deepEqual(db.agentOrderSettings(), { agentIds: ['b', 'c', 'a'], updatedAt: 300 });
    assert.deepEqual(db.saveAgentOrderSettings([], 400), { agentIds: [], updatedAt: 400 });
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('案例排序存储：手动顺序先于热门位，分页筛选不改变顺序，新记录补到末尾', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-order-list-'));
  let db;
  try {
    db = createDatabase({ databasePath: join(dir, 'order.db') });
    db.insertAgent(agentRecord('a', 100, { discipline: '理学' }));
    db.insertAgent(agentRecord('b', 400));
    db.insertAgent(agentRecord('c', 300, { discipline: '理学', status: 'inactive' }));
    db.insertAgent(agentRecord('d', 200));
    const featured = db.saveFeaturedAgentSettings(['a', null, 'd'], 500);
    const ids = (options) => db.listAgents(options).items.map((row) => row.id);
    assert.deepEqual(ids(), ['a', 'd', 'b', 'c'], '未保存手动顺序时沿用原热门置顶');
    db.saveAgentOrderSettings(['c', 'b', 'a', 'd'], 600);
    assert.deepEqual(ids(), ['c', 'b', 'a', 'd']);
    assert.deepEqual(ids({ limit: 2 }), ['c', 'b']);
    assert.deepEqual(ids({ limit: 2, offset: 2 }), ['a', 'd']);
    assert.deepEqual(ids({ discipline: '理学' }), ['c', 'a']);
    assert.equal(db.listAgents({ discipline: '理学' }).total, 2);
    assert.deepEqual(ids({ status: 'active' }), ['b', 'a', 'd']);
    assert.deepEqual(ids({ query: '案例', status: 'active', limit: 2, offset: 1 }), ['a', 'd']);
    assert.deepEqual(db.featuredAgentSettings(), featured, '拖动排序不能改热门展示配置');

    db.insertAgent(agentRecord('new', 5000));
    assert.deepEqual(ids(), ['c', 'b', 'a', 'd', 'new']);
    db.deleteAgent('b');
    assert.deepEqual(ids(), ['c', 'a', 'd', 'new']);
    assert.equal(db.listAgents().total, 4);
    db.updateAgent(agentRecord('c', 9000, { discipline: '理学', status: 'active' }));
    assert.deepEqual(ids({ status: 'active' }), ['c', 'a', 'd', 'new'], '恢复显示和编辑不改变手动位置');
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('案例排序 PostgreSQL 契约：幂等建表、参数化覆盖和数值时间戳，与 SQLite 接口相同', async (t) => {
  const calls = [];
  let stored;
  t.mock.method(PgClient.prototype, 'query', async function (sql, params = []) {
    calls.push({ sql, params });
    if (/^SELECT data_json, updated_at FROM agent_order_settings/.test(sql)) {
      return { rows: stored ? [stored] : [] };
    }
    if (/INSERT INTO agent_order_settings/.test(sql)) {
      stored = { data_json: params[0], updated_at: String(params[1]) };
    }
    if (/SELECT COUNT\(\*\)::int AS total FROM agents/.test(sql)) return { rows: [{ total: '0' }] };
    return { rows: [] };
  });
  const db = await createPgStorage({ connectionString: 'postgresql://test@localhost/test?sslmode=require&channel_binding=require', now: () => 123 });
  try {
    assert.ok(calls.some(({ sql }) => /CREATE TABLE IF NOT EXISTS agent_order_settings/.test(sql)));
    assert.deepEqual(await db.agentOrderSettings(), { agentIds: [], updatedAt: null });
    assert.deepEqual(await db.saveAgentOrderSettings(['b', 'a']), { agentIds: ['b', 'a'], updatedAt: 123 });
    assert.deepEqual(await db.agentOrderSettings(), { agentIds: ['b', 'a'], updatedAt: 123 });
    const write = calls.find(({ sql }) => /INSERT INTO agent_order_settings/.test(sql));
    assert.deepEqual(write.params, ['["b","a"]', 123]);
    assert.match(write.sql, /ON CONFLICT \(id\) DO UPDATE/);
    await db.listAgents({ query: '课程', status: 'active', limit: 50, offset: 50 });
    const list = calls.find(({ sql }) => /LIMIT \$6 OFFSET \$7/.test(sql));
    assert.match(list.sql, /jsonb_array_elements_text\(settings.data_json::jsonb\)/);
    assert.match(list.sql, /FROM agent_order_settings AS settings/);
    assert.ok(list.sql.indexOf('manual_order.position ASC') < list.sql.indexOf('featured.position ASC'));
    assert.deepEqual(list.params, ['课程', '%课程%', '', '', 'active', 50, 50]);
  } finally {
    await db.close();
  }
});
