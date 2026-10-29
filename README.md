# agent-official-website

智能体官网：暗黑科幻风滚动叙事首页（WebGL 点云星云随滚动变形为「人形点阵 → 骨骼 → 头骨」）
+ 智能体查询平台 + 管理端，接入超星统一认证中心（SSO）与 SQLite 数据存储。

- 首页还原基准：`doc/restore-spec.md`（参考站点组件 jiro.build · Human Synthesis Header 的还原实现）
- SSO 对接契约：`doc/sso-integration.md`
- 前台修复记录：`doc/agent-frontend-fixes.md`（图片上传 / 字段展示 / 弹窗样式 / 链接跳转，含变更清单与验证结果）
- 验收记录：`doc/acceptance-checklist.md`

## 页面与功能

| 页面 | 路径 | 说明 |
|---|---|---|
| 首页 | `/` | WebGL 滚动叙事（六个相位 + 四组文案），末幕含登录区与查询平台入口 |
| 智能体查询平台 | `/agents.html` | 关键词检索、标签渲染、详情弹窗；读接口匿名开放；管理员顶栏含「管理端 →」入口 |
| 管理端 | `/admin.html` | 门禁按 `isAdmin` 判定；管理员可新增智能体、查看明细；顶栏含「查询平台 →」入口 |

### 登录后分流

登录成功（SSO 回调验票通过）后由后端按角色决定落点，避免管理员还需手动找管理端：

| 身份 | 落点 |
|---|---|
| 管理员（`ADMIN_ROLES` 或 `ADMIN_SSO_UIDS` 命中） | `/admin.html`（可直接新增 / 上传智能体） |
| 普通用户 | `/agents.html`（查询平台，直接开始检索） |
| 登录失败 | `/`（首页末幕登录区显示对应中文错误提示） |

管理员判定配置在 `.env`：`ADMIN_ROLES=admin`（角色名，大小写不敏感）、`ADMIN_SSO_UIDS`（uid 白名单兜底，逗号分隔，改完重启后端生效）。

## 技术栈

| 项 | 说明 |
|---|---|
| 页面 | 原生 HTML + CSS + ES Modules JS，无构建步骤 |
| 渲染 | 本地 three.js（`project/frontend/libs/three`），含 EffectComposer / UnrealBloomPass |
| 噪声 | simplex-noise 等效实现（`project/frontend/js/noise.js`） |
| 后端 | Node 内置模块（`node:http` 零依赖），`project/backend/server.mjs` 同源托管前端 + `/api` |
| 认证 | 超星 SSO：授权 → 一次性 ticket → 服务端验票 → 本站会话 Cookie（见 `doc/sso-integration.md`） |
| 数据库 | SQLite（Node 内置 `node:sqlite`），结构见 `database/schema.sql` |

## 端口登记

| 服务 | 端口 | 状态 | 说明 |
|---|---|---|---|
| 后端服务（含站点入口） | **2001** | 使用中 | 主入口，同时托管前端静态资源与 `/api`；区间 2001–3000 |
| 前端静态预览 | **1002** | 备用 | `python -m http.server` 纯静态预览（无登录/接口）；区间 1001–2000 |

> 同机端口核对：`D:\Crow5\Project\case1-agent-frontend` 使用 5173 / 8787，与本项目无冲突。

## 启动方式

### 主入口（推荐，含登录与数据接口）

```bash
# 项目根目录；首次先复制配置：cp .env.example .env 后填写认证中心地址与密钥
node .preview-server.js            # 默认 127.0.0.1:2001
node .preview-server.js --port 2001  # 可选：临时覆盖端口
```

访问：<http://127.0.0.1:2001/>（查询平台 `/agents.html`，管理端 `/admin.html`）

> `.preview-server.js` 自动加载根目录 `.env`（已存在的进程环境变量优先）。

### 纯静态预览（无后端，仅首页视觉）

```bash
cd project/frontend && python -m http.server 1002 --bind 127.0.0.1
```

访问：<http://127.0.0.1:1002>（顶栏会提示「未连接后端」，登录不可用）

## 数据库信息

| 项 | 值 |
|---|---|
| 引擎 | SQLite（Node 内置 `node:sqlite`，零外部依赖） |
| 文件 | `database/agent-website.db`（运行时自动创建，已加入 .gitignore） |
| 账号 / 密码 | 无（文件型数据库，无需连接凭据） |
| 结构定义 | `database/schema.sql`（启动时执行 `CREATE TABLE IF NOT EXISTS`） |
| 表 | `users`（SSO 用户档案）/ `sessions`（会话，仅存 token 的 sha256）/ `agents`（智能体数据） |
| 配置键 | `DB_PATH`（`.env`，默认 `database/agent-website.db`） |

## 目录结构

```text
agent-official-website/
├─ README.md              本文件
├─ .preview-server.js     本地启动入口（加载 .env → 启动后端）
├─ .env.example           配置模板（复制为 .env 填写真实值）
├─ doc/                   文档（restore-spec / sso-integration / acceptance-checklist）
├─ prototype/             产品原型目录
├─ project/
│  ├─ frontend/           前端源码（index.html / agents.html / admin.html / styles.css / js / libs / fonts）
│  └─ backend/            后端服务（server.mjs / database.mjs）
├─ database/              数据库（schema.sql + 运行时 db 文件）
└─ utils/
   ├─ tests/              单元 + 接口测试（node --test，零依赖）
   ├─ verify/             CDP 自动化页面验证工具（cdp-verify / cdp-interact / cdp-site-verify）
   └─ ref-fetch/          参考素材（组件源码 chunk、样式、预览页等）
```

## 验证方式

### 1. 单元 + 接口测试（零依赖，含 SSO 全链路）

```bash
node --test "utils/tests/*.test.mjs"
```

覆盖：白名单/票据/身份解析/管理员判定、SSO 往返全链路、票据一次性、401/403 权限边界、
输入校验、静态资源与路径穿越防护、封面上传（multipart / 内容魔数 / 10 MB 上限）、
智能体字段完整性（表单 → 接口 → 列表 / 详情响应）。

> 若环境禁止测试运行器派生子进程（报 `spawn EPERM`），改用同进程模式：
> `node --test --experimental-test-isolation=none "utils/tests/*.test.mjs"`。

### 2. CDP 页面验证（真实浏览器）

1. 前置：后端 2001 已启动（**改完后端代码必须重启**，前端静态资源刷新即可）；Chrome 以 `--remote-debugging-port=9222` 启动。
2. 运行：

```bash
# 首页视觉还原（滚动相位 / 响应式 / WebGL 非全黑 / 控制台零报错）
node utils/verify/cdp-verify.mjs

# 首页交互状态
node utils/verify/cdp-interact.mjs

# 站点全链路（登录区、管理端门禁、查询平台、权限边界）
node utils/verify/cdp-site-verify.mjs

# 智能体前台四项修复专项（上传回显 / 字段完整 / 弹窗样式 / 链接跳转 / 三档响应式）
node utils/verify/cdp-agent-fix.mjs

# 登录分流与回调提示（管理员 → 管理端 / 普通用户 → 查询平台）
node utils/verify/cdp-login-routing.mjs
```

3. 产物：截图与 `report.json` 输出到 `utils/verify/shots/`（已加入 .gitignore）。

## 注意事项

- **服务重启**：前台进程，终端关闭 / 机器重启后需重新执行启动命令。
- **端口冲突**：后端固定 2001、静态预览 1002，均已在本文档登记；被占用时先排查占用进程。
- **密钥安全**：`.env` 含 `SSO_SHARED_SECRET`，禁止提交仓库（已加入 .gitignore）；对外仅提供 `.env.example`。
- **无构建步骤**：前端直接改 `project/frontend/`，刷新浏览器即生效；后端改 `project/backend/` 后**必须重启进程**（否则新增接口 / 新增字段不会生效，表现为上传 404、填写字段不落库）。
- **验证脚本依赖**：需 Node.js 18+（使用原生 `fetch` / `WebSocket`）；Chrome 调试端口 9222 复用时脚本只操作同源标签页。
