#!/usr/bin/env node
/**
 * 云端部署启动入口（云端/沙箱使用，本地仍用 .preview-server.js）
 * - 桥接 Coze 部署平台注入的 DEPLOY_RUN_PORT -> PORT
 * - 云端需监听 0.0.0.0（本地默认 127.0.0.1 仅回环）
 * - 优先使用平台注入的环境变量；其次读取随部署包上传的 prod.env（生产配置，
 *   .env 会被部署打包器排除，prod.env 不会）；最后读取 .env（本地/沙箱开发值）。
 *   三者均为"补充未注入的配置"，不覆盖已存在的进程环境变量。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 最简 .env 加载器（不覆盖已存在的进程环境变量） */
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return false;
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// 优先级：平台注入 > prod.env（随包上传的生产配置）> .env（开发值，不随包上传）
loadDotEnv(resolve(ROOT, 'prod.env'));
loadDotEnv(resolve(ROOT, '.env'));

// 数据库连接串归一：平台数据库插件可能注入 PGDATABASE_URL / PGDATABASE_URL_PROD / PGDATABASE_URL_DEV，
// 任一存在即映射为应用读取的 DATABASE_URL（显式 DATABASE_URL 优先）
if (!process.env.DATABASE_URL) {
  for (const key of ['PGDATABASE_URL', 'PGDATABASE_URL_PROD', 'PGDATABASE_URL_DEV']) {
    const value = process.env[key];
    if (typeof value === 'string' && /^postgres(ql)?:\/\//i.test(value.trim())) {
      process.env.DATABASE_URL = value.trim();
      break;
    }
  }
}

if (process.env.DEPLOY_RUN_PORT && !process.env.PORT) {
  process.env.PORT = process.env.DEPLOY_RUN_PORT;
}
if (!process.env.BACKEND_HOST) {
  process.env.BACKEND_HOST = '0.0.0.0';
}

/**
 * 生产环境（veFaaS）项目目录只读，唯一可写目录是 /tmp。
 * - 配置了 DATABASE_URL（PostgreSQL 持久化）时使用托管数据库，数据不丢失；
 *   此时无需重定向 SQLite 的 DB_PATH。
 * - 未配置 DATABASE_URL 时回退 SQLite：DB_PATH 必须重定向到 /tmp，
 *   但 /tmp 为临时目录，实例重启/重新部署后数据不保留（仅作兜底，不建议长期使用）。
 * - 封面上传目录始终重定向到 /tmp（对象未做持久化时重启会丢失）。
 */
const isAbsolutePath = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p));
const hasPostgres = typeof process.env.DATABASE_URL === 'string' && /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL);
if (process.env.COZE_PROJECT_ENV === 'PROD') {
  if (!hasPostgres && !isAbsolutePath(process.env.DB_PATH)) {
    process.env.DB_PATH = '/tmp/agent-website/agent-website.db';
  }
  if (!isAbsolutePath(process.env.UPLOADS_DIR)) {
    process.env.UPLOADS_DIR = '/tmp/agent-website/uploads';
  }
}
const { startPreviewServer } = await import('./project/backend/server.mjs');
await startPreviewServer();
