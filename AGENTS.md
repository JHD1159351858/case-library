# AGENTS.md

## 项目概览
agent-official-website（case-library）：智能体官网，暗黑科幻风滚动叙事首页（WebGL 点云星云）+ 智能体查询平台 + 管理端。接入超星 SSO 统一认证，支持 PostgreSQL 持久化与 SQLite 本地双数据存储。

- 首页 `/`：WebGL 滚动叙事，末幕含登录区与查询平台入口
- 查询平台 `/agents.html`：关键词检索、标签渲染、详情弹窗（读接口匿名开放）
- 管理端 `/admin.html`：按 `isAdmin` 门禁，管理员新增/查看智能体

## 技术栈
- 前端：原生 HTML + CSS + ES Modules JS，无构建步骤；本地 three.js（`project/frontend/libs/three`）
- 后端：Node 内置模块零依赖（`node:http`），`project/backend/server.mjs` 同源托管前端 + `/api`
- 数据库（二选一，启动时按 `DATABASE_URL` 自动选择）：
  - **PostgreSQL（生产/持久化）**：配置 `DATABASE_URL=postgresql://...?sslmode=require&channel_binding=require` 启用。零 npm 依赖，用内置 `project/backend/pg-wire.mjs`（原生 v3 线协议 + SCRAM-SHA-256-PLUS + TLS）连接，数据访问层 `project/backend/pg-storage.mjs`，表结构 `database/schema-postgres.sql`（启动幂等建表）
  - **SQLite（本地/兜底）**：未配置 `DATABASE_URL` 时使用 Node 内置 `node:sqlite`，数据访问层 `project/backend/database.mjs`，表结构 `database/schema.sql`
  - 两套实现导出**同名、同签名、同返回结构**的 storage 接口；`server.mjs` 中所有 db 调用均 `await`（兼容同步 SQLite 返回值）
- 要求：Node 24（见 `.coze` requires）

## 构建与运行
| 场景 | 命令 |
|---|---|
| 沙箱/云端启动 | `node start-cloud.mjs`（桥接 `DEPLOY_RUN_PORT`→`PORT`，监听 0.0.0.0，加载 `.env`） |
| 本地开发 | `node .preview-server.js`（默认 127.0.0.1:2001） |
| 单元+接口测试 | `node --test "utils/tests/*.test.mjs"`；若报 `spawn EPERM` 加 `--experimental-test-isolation=none` |

`.coze` 的 dev/deploy 均指向 `start-cloud.mjs`，**不要修改 `.coze`**。

## 配置（.env，不入库）
- `APP_PUBLIC_URL` / `SSO_ALLOWED_RETURN_ORIGINS`：本站对外 origin（回调与白名单）。**生产无需配置**：未显式配置时服务端按请求头（`x-forwarded-proto`/`x-forwarded-host`/`host`）自动推导对外 origin，且 return_to 白名单始终放行本请求自身 origin
- `prod.env`（根目录，不入 git）：**生产配置文件，随部署包上传**（部署打包器排除 `.env` 但不排除它）。生产数据库/SSO/管理员配置写在这里；平台注入的同名环境变量优先于它。含数据库密码，已加入 .gitignore 防止误提交
- `SSO_CENTER_URL` / `SSO_SHARED_SECRET`：超星认证中心；未配置真实值时登录不可用，其余功能正常
- `ADMIN_ROLES` / `ADMIN_SSO_UIDS`：管理员判定（角色名大小写不敏感 + uid 白名单兜底，改完重启生效）
- `DATABASE_URL`：PostgreSQL 连接串（生产持久化首选）。配置后走 PG，`DB_PATH` 被忽略；**生产环境通过平台环境变量/Secret 注入，不要写入仓库或沙箱 `.env`**。连接串必须带 `sslmode=require&channel_binding=require`
- `DB_PATH`：SQLite 文件路径（仅未配置 `DATABASE_URL` 时使用），默认 `database/agent-website.db`。生产环境（veFaaS）目录只读：`start-cloud.mjs` 在 `COZE_PROJECT_ENV=PROD` 且**未配置 PG** 时把相对 `DB_PATH`/`UPLOADS_DIR` 重定向到 `/tmp/agent-website/`（临时目录，重启数据丢失，仅兜底）；配置了 PG 则不重定向 DB_PATH
- `UPLOADS_DIR`：封面上传目录，生产环境始终重定向到 `/tmp`（重启丢失，如需长期保留需再接对象存储）
- `COZE_API_TOKEN` / `COZE_BOT_ID`：对话查找（扣子），两项齐全才启用
- 不要设置 `BACKEND_PORT`/`BACKEND_HOST`，避免覆盖平台注入值

### 生产环境必须配置的环境变量（在部署平台/Secret 配置，不入仓库）
- `DATABASE_URL`：PG 连接串（持久化数据库）
- `SSO_CENTER_URL` / `SSO_SHARED_SECRET`：超星认证中心地址与验票密钥
- `APP_PUBLIC_URL` / `SSO_ALLOWED_RETURN_ORIGINS`：线上域名 origin
- `ADMIN_ROLES` / `ADMIN_SSO_UIDS`：管理员判定
- 沙箱/本地 `.env` 仅放开发值，真实 SSO 密钥与 PG 连接串不落沙箱

## API 速查（`project/backend/server.mjs`）
- `GET /api/health`、`GET /api/auth/me`、`GET /api/auth/chaoxing/start|callback`、`POST /api/auth/logout`
- `GET /api/agents`（匿名读）、`POST /api/agents`（管理员，未授权 401 为预期行为）
- `GET /api/agents/stats`、`POST /api/agents/chat`、`GET /api/card-effects`、`POST /api/uploads`（管理员）

## 代码风格与注意事项
- 全项目零 npm 依赖，禁止引入包管理器；标点半角，ES Modules
- 改后端代码必须重启进程；前端静态资源刷新即可
- 路径穿越防护、上传魔数校验（3 MB 上限）、会话仅存 token sha256，修改时勿破坏
- 文档：`doc/restore-spec.md`（首页还原基准）、`doc/sso-integration.md`（SSO 契约）
