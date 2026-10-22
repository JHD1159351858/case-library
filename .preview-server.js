#!/usr/bin/env node
/**
 * 本地预览服务入口（项目根）
 *
 * 用法：
 *   node .preview-server.js               # 默认 127.0.0.1:2001
 *   node .preview-server.js --port 2001   # 临时覆盖端口
 *   node .preview-server.js --help
 *
 * 说明：
 *   - 自动加载根目录 .env（已存在的进程环境变量优先，便于临时覆盖）
 *   - 启动 project/backend/server.mjs：同源托管前端页面 + SSO 回调 + /api
 *   - 对应关系：前端端口区间 1001–2000（本项目登记 1002，python 静态预览用）；
 *     本服务端口 2001（后端区间 2001–3000），站点入口也是 2001
 *
 * 注意：本文件是开发/联调入口，SSO_SHARED_SECRET 等敏感值只从 .env 读取，
 *       不得写入仓库（.env 已加入 .gitignore）。
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

function parseArgs(argv) {
  const options = { port: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--port' || arg === '-p') options.port = argv[++i];
    else if (arg.startsWith('--port=')) options.port = arg.slice('--port='.length);
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`本地预览服务（agent-official-website）

  node .preview-server.js [--port <端口>]

  默认端口 2001，配置文件 .env（根目录）。
  站点入口      http://127.0.0.1:2001/
  智能体平台    http://127.0.0.1:2001/agents.html
  管理端        http://127.0.0.1:2001/admin.html`);
  process.exit(0);
}

const envLoaded = loadDotEnv(resolve(ROOT, '.env'));
const port = args.port ? Number.parseInt(args.port, 10) : undefined;

if (!envLoaded) {
  console.warn('[preview] 未找到 .env，将使用默认配置（SSO 未配置时登录不可用）');
}

const { startPreviewServer } = await import('./project/backend/server.mjs');
const { createCozeAgentChatProvider } = await import('./project/backend/coze-agent-chat.mjs');
const agentChatProvider = createCozeAgentChatProvider({ token: process.env.COZE_API_TOKEN, botId: process.env.COZE_BOT_ID });
startPreviewServer(port ? { port } : {}, { agentChatProvider });
