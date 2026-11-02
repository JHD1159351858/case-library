import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase } from '../../project/backend/database.mjs';

function insertAgent(db, id) {
  return db.insertAgent({
    id,
    name: `案例${id}`,
    summary: '',
    tags: '',
    status: 'active',
    dataJson: '{}',
    discipline: '',
    major: '',
    courseName: '',
    agentUrl: '',
    schoolName: '',
    coverImage: '',
    painPoint: '',
    usageGuide: '',
    createdBy: null,
    createdAt: 100,
    updatedAt: 100
  });
}

test('全站访问人数：初始为零，同一浏览器只计一次且不改首次访问时间', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-visits-count-'));
  const databasePath = join(dir, 'visits.db');
  let db;
  let inspect;
  try {
    db = createDatabase({ databasePath });
    assert.deepEqual(db.siteVisitStats(), { visitorCount: 0 });

    db.recordSiteVisit({ visitorKey: 'browser-a', timestamp: 100 });
    db.recordSiteVisit({ visitorKey: 'browser-a', timestamp: 999 });
    assert.deepEqual(db.siteVisitStats(), { visitorCount: 1 });

    db.recordSiteVisit({ visitorKey: 'browser-b', timestamp: 200 });
    assert.deepEqual(db.siteVisitStats(), { visitorCount: 2 });

    inspect = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      inspect.prepare('SELECT first_visited_at FROM site_visitors WHERE visitor_key = ?').get('browser-a').first_visited_at,
      100
    );
  } finally {
    inspect?.close();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('全站访问人数：另一连接与重启后保留去重结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-visits-reopen-'));
  const databasePath = join(dir, 'visits.db');
  let first;
  let second;
  let reopened;
  try {
    first = createDatabase({ databasePath });
    first.recordSiteVisit({ visitorKey: 'browser-a', timestamp: 100 });

    second = createDatabase({ databasePath });
    assert.deepEqual(second.siteVisitStats(), { visitorCount: 1 });
    second.recordSiteVisit({ visitorKey: 'browser-a', timestamp: 200 });
    second.recordSiteVisit({ visitorKey: 'browser-b', timestamp: 300 });
    assert.deepEqual(first.siteVisitStats(), { visitorCount: 2 });

    second.close();
    second = null;
    first.close();
    first = null;
    reopened = createDatabase({ databasePath });
    assert.deepEqual(reopened.siteVisitStats(), { visitorCount: 2 });
  } finally {
    reopened?.close();
    second?.close();
    first?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('全站访问人数：旧库启动时幂等建表，且删除案例不影响累计人数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-visits-migration-'));
  const databasePath = join(dir, 'legacy.db');
  let legacy;
  let db;
  let inspect;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY) STRICT;');
    legacy.close();
    legacy = null;

    db = createDatabase({ databasePath });
    inspect = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      inspect.prepare('PRAGMA table_info(site_visitors)').all().map((column) => column.name),
      ['visitor_key', 'first_visited_at']
    );
    inspect.close();
    inspect = null;
    db.recordSiteVisit({ visitorKey: 'browser-a', timestamp: 100 });
    insertAgent(db, 'agent-to-delete');
    assert.equal(db.deleteAgent('agent-to-delete'), true);
    assert.deepEqual(db.siteVisitStats(), { visitorCount: 1 });
  } finally {
    inspect?.close();
    db?.close();
    legacy?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
