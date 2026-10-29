import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase } from '../../project/backend/database.mjs';

test('图片存储：旧库补表，二进制零字节跨关闭重开原样保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'upload-storage-'));
  const databasePath = join(directory, 'legacy.db');
  let db;
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE card_effect_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;`);
    legacy.close();

    db = createDatabase({ databasePath });
    assert.equal(db.findUpload('missing.png'), null);
    const image = {
      fileName: 'persistent.png',
      contentType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x00]),
      createdAt: 123456789
    };
    db.saveUpload(image);
    assert.deepEqual(db.findUpload(image.fileName), image);
    db.close();
    db = null;

    db = createDatabase({ databasePath });
    const restored = db.findUpload(image.fileName);
    assert.equal(Buffer.isBuffer(restored.data), true);
    assert.deepEqual(restored, image);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('图片存储：另一数据库连接可读取和删除同一图片', () => {
  const directory = mkdtempSync(join(tmpdir(), 'upload-shared-'));
  const databasePath = join(directory, 'shared.db');
  let writer;
  let reader;
  try {
    writer = createDatabase({ databasePath });
    reader = createDatabase({ databasePath });
    const image = {
      fileName: 'shared.webp',
      contentType: 'image/webp',
      data: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xfe, 0xff]),
      createdAt: 987654321
    };
    writer.saveUpload(image);
    assert.deepEqual(reader.findUpload(image.fileName), image);
    reader.deleteUpload(image.fileName);
    assert.equal(writer.findUpload(image.fileName), null);
    assert.equal(reader.findUpload(image.fileName), null);
  } finally {
    reader?.close();
    writer?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
