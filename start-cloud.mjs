#!/usr/bin/env node
/**
 * 云端部署启动入口（仅云端使用，本地仍用 .preview-server.js）
 * - 桥接 Coze 部署平台注入的 DEPLOY_RUN_PORT -> PORT
 * - 云端需监听 0.0.0.0（本地默认 127.0.0.1 仅回环）
 * - 不加载 .env；所有配置由云端环境变量注入
 */
if (process.env.DEPLOY_RUN_PORT && !process.env.PORT) {
  process.env.PORT = process.env.DEPLOY_RUN_PORT;
}
if (!process.env.BACKEND_HOST) {
  process.env.BACKEND_HOST = '0.0.0.0';
}
const { startPreviewServer } = await import('./project/backend/server.mjs');
startPreviewServer();