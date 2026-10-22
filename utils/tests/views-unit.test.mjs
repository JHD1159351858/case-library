/** 浏览统计数据库测试（真实 SQLite 临时库，零依赖） */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createDatabase } from '../../project/backend/database.mjs';

const ZERO = { userCount: 0, anonymousCount: 0, viewCount: 0 };

function record(id = 'a1') {
  return {
    id, name: '浏览统计案例', summary: '', tags: '', status: 'active', dataJson: '{}',
    discipline: '', major: '', courseName: '', agentUrl: '', schoolName: '',
    coverImage: '', painPoint: '', usageGuide: '', createdBy: null, createdAt: 100, updatedAt: 100
  };
}

function user(db, ssoUid, displayName = '测试用户') {
  return db.upsertUserFromIdentity({
    ssoUid, name: 'account', displayName, role: 'teacher', roles: [], openid: '', fid: '', orgName: ''
  }, false, 100);
}

function withDatabase(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-view-unit-'));
  const databasePath = join(dir, 'test.db');
  const db = createDatabase({ databasePath });
  try {
    return run(db, databasePath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('浏览统计：新案例从零开始，详情为空且返回分页信息', () => {
  withDatabase((db) => {
    db.insertAgent(record());
    assert.deepEqual(db.agentViewStats('a1'), ZERO);
    assert.deepEqual(db.listAgentViews('a1'), { items: [], total: 0, limit: 50, offset: 0 });
    assert.deepEqual(db.agentViewStatsForAgents([]), new Map());
  });
});

test('浏览统计：同一账号重复浏览只增次数，保留首次时间且不修改案例更新时间', () => {
  withDatabase((db) => {
    db.insertAgent(record());
    const viewer = user(db, 'viewer-1', '张老师');
    db.recordAgentView({ agentId: 'a1', visitorKey: `u:${viewer.id}`, userId: viewer.id, timestamp: 200 });
    db.recordAgentView({ agentId: 'a1', visitorKey: `u:${viewer.id}`, userId: viewer.id, timestamp: 300 });
    assert.deepEqual(db.agentViewStats('a1'), { userCount: 1, anonymousCount: 0, viewCount: 2 });
    assert.deepEqual(db.listAgentViews('a1').items, [{
      visitorType: 'user', displayName: '张老师', viewCount: 2, firstViewedAt: 200, lastViewedAt: 300
    }]);
    assert.equal(db.findAgentById('a1').updated_at, 100);
    user(db, 'viewer-1', '张老师新展示名');
    assert.equal(db.listAgentViews('a1').items[0].displayName, '张老师新展示名');
  });
});

test('浏览统计：账号与匿名浏览器分别去重，批量聚合不混入其他案例', () => {
  withDatabase((db) => {
    db.insertAgent(record('a1'));
    db.insertAgent(record('a2'));
    db.insertAgent(record('a3'));
    for (const ssoUid of ['one', 'two']) {
      const viewer = user(db, ssoUid);
      db.recordAgentView({ agentId: 'a1', visitorKey: `u:${viewer.id}`, userId: viewer.id, timestamp: 200 });
    }
    for (const visitorKey of ['a:one', 'a:one', 'a:two']) {
      db.recordAgentView({ agentId: 'a1', visitorKey, userId: null, timestamp: 300 });
    }
    db.recordAgentView({ agentId: 'a2', visitorKey: 'a:one', userId: null, timestamp: 400 });
    const stats = db.agentViewStatsForAgents(['a1', 'a3']);
    assert.deepEqual(stats.get('a1'), { userCount: 2, anonymousCount: 2, viewCount: 5 });
    assert.deepEqual(stats.get('a3'), ZERO);
    assert.equal(stats.has('a2'), false);
    assert.deepEqual(db.agentViewStats('a2'), { userCount: 0, anonymousCount: 1, viewCount: 1 });
  });
});

test('浏览明细：按最近时间倒序稳定分页，不泄露身份键与 SSO 字段', () => {
  withDatabase((db) => {
    db.insertAgent(record());
    const viewer = user(db, 'private-sso-id', '王老师');
    db.recordAgentView({ agentId: 'a1', visitorKey: `u:${viewer.id}`, userId: viewer.id, timestamp: 400 });
    db.recordAgentView({ agentId: 'a1', visitorKey: 'a:first-private-key', timestamp: 100 });
    db.recordAgentView({ agentId: 'a1', visitorKey: 'a:first-private-key', timestamp: 300 });
    db.recordAgentView({ agentId: 'a1', visitorKey: 'a:second-private-key', timestamp: 300 });
    const first = db.listAgentViews('a1', { limit: 1 });
    assert.equal(first.items[0].displayName, '王老师');
    assert.equal(first.total, 3);
    const second = db.listAgentViews('a1', { limit: 1, offset: 1 });
    assert.deepEqual(second.items[0], {
      visitorType: 'anonymous', displayName: '匿名访客', viewCount: 2, firstViewedAt: 100, lastViewedAt: 300
    });
    const third = db.listAgentViews('a1', { limit: 1, offset: 2 });
    assert.equal(third.items[0].viewCount, 1);
    const serialized = JSON.stringify(db.listAgentViews('a1'));
    for (const secret of ['private-sso-id', 'first-private-key', 'visitor_key', 'user_id', 'openid', 'sso_uid']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.deepEqual(db.listAgentViews('a1', { limit: 10000, offset: -10 }), {
      ...db.listAgentViews('a1'), limit: 100, offset: 0
    });
  });
});

test('浏览统计：案例和用户删除级联清理，未知外键拒绝写入', () => {
  withDatabase((db, databasePath) => {
    db.insertAgent(record());
    const viewer = user(db, 'deleted-user');
    db.recordAgentView({ agentId: 'a1', visitorKey: `u:${viewer.id}`, userId: viewer.id, timestamp: 200 });
    db.recordAgentView({ agentId: 'a1', visitorKey: 'a:anonymous', timestamp: 200 });
    assert.throws(() => db.recordAgentView({ agentId: 'missing', visitorKey: 'a:any', timestamp: 200 }), /FOREIGN KEY/);
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec('PRAGMA foreign_keys = ON');
      raw.prepare('DELETE FROM users WHERE id = ?').run(viewer.id);
      assert.deepEqual(db.agentViewStats('a1'), { userCount: 0, anonymousCount: 1, viewCount: 1 });
      db.deleteAgent('a1');
      assert.equal(raw.prepare('SELECT COUNT(*) AS total FROM agent_views').get().total, 0);
    } finally {
      raw.close();
    }
  });
});

test('浏览统计：存量库增表幂等，重启保留原案例和浏览记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-view-legacy-'));
  const databasePath = join(dir, 'old.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', data_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;`);
  legacy.prepare('INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('old', '原有案例', 10, 10);
  legacy.close();
  let db;
  try {
    db = createDatabase({ databasePath });
    assert.deepEqual(db.agentViewStats('old'), ZERO);
    db.recordAgentView({ agentId: 'old', visitorKey: 'a:persistent', timestamp: 200 });
    db.close();
    db = createDatabase({ databasePath });
    assert.equal(db.findAgentById('old').name, '原有案例');
    assert.deepEqual(db.agentViewStats('old'), { userCount: 0, anonymousCount: 1, viewCount: 1 });
    assert.equal(db.listAgentViews('old').items[0].firstViewedAt, 200);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
