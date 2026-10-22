# SSO 联登对接文档（超星统一认证中心）

> 维护基准：`project/backend/server.mjs` 当前实现。若实现与本文冲突，以代码为准并同步更新本文。
> 关联文件：`.env.example`（配置模板）、`database/schema.sql`（users / sessions 表）、`utils/tests/unit.test.mjs`、`utils/tests/api.test.mjs`（契约测试）。

## 1. 角色与目标

| 角色 | 说明 |
|---|---|
| 本站（依赖方） | 智能体官网后端（`project/backend/server.mjs`，默认 `http://127.0.0.1:2001`） |
| 认证中心（身份方） | 超星统一认证中心（`SSO_CENTER_URL`，如 `https://sdtqvk3ybm.coze.site`） |

目标：用户在本站点击「登录」后跳转认证中心完成授权，回到本站即建立本地会话（7 天），
管理端权限按角色动态判定，全链路共享密钥不出服务端。

## 2. 完整时序

```text
浏览器                 本站后端                        认证中心
  │  点击「登录」          │                              │
  │ ──GET /api/auth/chaoxing/start──────────────────────▶│
  │                        │ 302 → {SSO_CENTER_URL}/api/auth/chaoxing?return_to=<回调绝对URL>
  │ ◀──────────────────────│                              │
  │ ──GET 授权页（带 return_to）────────────────────────▶│
  │                        │                              │ 校验 return_to 合法性
  │ ◀──302 回跳 return_to?ticket=<一次性ticket>───────────│
  │ ──GET /api/auth/chaoxing/callback?ticket=xxx────────▶│
  │                        │ ──POST /api/sso/verify {ticket, secret}──▶
  │                        │ ◀──200 身份 JSON / 4xx 错误码─────────────│
  │                        │ upsert users → create sessions（存 sha256）
  │                        │ Set-Cookie: agent_site_session（HttpOnly）
  │ ◀──302 /?scene=last&login=ok─────────────────────────│
  │ 前端读取 /api/auth/me 渲染登录态                        │
```

## 3. 认证中心契约（对外依赖，共 3 个端点）

### 3.1 授权入口

```http
GET {SSO_CENTER_URL}/api/auth/chaoxing?return_to=<绝对URL>
```

- `return_to`：本站回调地址（默认 `{APP_PUBLIC_URL}/api/auth/chaoxing/callback`，允许被 `SSO_ALLOWED_RETURN_ORIGINS` 白名单内的地址覆盖）。
- 认证中心校验通过后携带 `ticket` 回跳 `return_to`。

### 3.2 验票

```http
POST {SSO_CENTER_URL}/api/sso/verify
Content-Type: application/json

{ "ticket": "<一次性票据>", "secret": "<SSO_SHARED_SECRET>" }
```

成功响应 `200`（身份 JSON，字段宽松解析，`uid` 为必填主键）：

```jsonc
{
  "uid": "10001",                 // 必填；兼容 userId / userid / user_id / sub
  "name": "zhangsan",             // 兼容 userName / username
  "displayName": "张三",           // 兼容 display_name / nickName / nickname
  "role": "admin",                // 可选
  "roles": [{ "roleId": "r1", "roleName": "admin" }],  // 可选；也兼容纯字符串数组
  "openid": "", "fid": "", "orgName": ""               // 可选
}
```

失败响应（本站映射为页面错误码，见 §6）：

| HTTP | error | 含义 |
|---|---|---|
| 401 | `invalid_secret` | 共享密钥不一致 |
| 400 | `invalid_ticket` | 票据缺失或格式错误 |
| 410 | `ticket_used` | 票据已被使用（一次性） |
| 410 | `ticket_expired`（默认） | 票据过期（有效期 120 秒） |

### 3.3 登出

```http
GET {SSO_CENTER_URL}/api/auth/logout?return_to=<回跳地址>
```

本站登出为两步：前端先 `POST /api/auth/logout` 清本站会话，再跳认证中心 `/api/auth/logout`
清理认证中心侧会话（否则下次登录会免密直接通过）。未配置认证中心时直接回跳本站。

> 实测说明（2026-09）：认证中心登出端点实测为 `/api/auth/logout`（旧写法 `/logout` 返回 404）。
> 该端点当前**忽略 `return_to`，固定 302 跳认证中心首页**，用户需自行返回本站；
> 本站仍携带 `return_to`，若认证中心后续支持回跳则无需改动本站。

## 4. 本站路由

| 方法 | 路径 | 说明 | 未登录 |
|---|---|---|---|
| GET | `/api/auth/chaoxing/start`（别名 `/api/auth/sso/start`） | 发起登录，302 至认证中心 | 开放 |
| GET | `/api/auth/chaoxing/callback`（别名 `/api/auth/sso/callback`） | 接收 `ticket` 验票建会话，302 回首页末幕 | 开放 |
| GET | `/api/auth/me` | 返回 `{ user, ssoEnabled }`；`user` 为 `null` 表示未登录 | 开放（读） |
| POST | `/api/auth/logout` | 删除本站会话，返回 `{ ok, logoutUrl }` | 开放（幂等） |
| GET | `/api/health` | 健康检查 | 开放 |
| GET | `/api/agents?q=` | 智能体检索（`total/items/query`） | 开放（读） |
| GET | `/api/agents/:id` | 智能体详情 | 开放（读） |
| POST | `/api/agents` | 新增智能体 | 401 / 403 |

回调成功后按身份分流落点（前端 `session.js` / `agents.js` / `admin.js` 读取后清理地址栏；失败仍回首页末幕展示）：

- 成功（管理员）：`/admin.html?login=ok` — 直达管理端，可立即新增 / 上传智能体
- 成功（普通用户）：`/agents.html?login=ok` — 直达查询平台
- 登出：`/?scene=last&logout=1`
- 失败：`/?scene=last&login_error=<错误码>`

`/api/auth/me` 用户结构（`publicUser`）：

```jsonc
{ "ssoUid": "10001", "name": "zhangsan", "displayName": "张三",
  "role": "admin", "orgName": "", "isAdmin": true }
```

## 5. 配置项（根目录 `.env`）

| 键 | 必填 | 说明 |
|---|---|---|
| `BACKEND_PORT` / `BACKEND_HOST` | 否 | 默认 `2001` / `127.0.0.1` |
| `APP_PUBLIC_URL` | 是 | 本站对外 origin，回调与白名单基准 |
| `SSO_CENTER_URL` | 是 | 认证中心地址；留空则 `ssoEnabled=false`，登录不可用 |
| `SSO_SHARED_SECRET` | 是 | 验票密钥，仅存服务端，绝不下发浏览器 |
| `SSO_ALLOWED_RETURN_ORIGINS` | 否 | `return_to` 白名单（逗号分隔），默认仅 `APP_PUBLIC_URL` |
| `ADMIN_ROLES` | 否 | 管理员判定：`role` / `roles` 命中清单（大小写不敏感），默认 `admin` |
| `ADMIN_SSO_UIDS` | 否 | 管理员判定兜底：认证中心 uid 清单（逗号分隔，留空不启用） |
| `DB_PATH` | 否 | 默认 `database/agent-website.db` |

## 6. 错误码（`login_error` → 前端中文提示）

| 错误码 | 触发点 | 前端提示 |
|---|---|---|
| `missing_ticket` | 回调无 `ticket` | 登录回调缺少票据，请重新发起登录。 |
| `invalid_secret` | 验票 401 | 密钥不一致，联系管理员核对 `SSO_SHARED_SECRET`。 |
| `invalid_ticket` | 验票 400 | 登录票据无效或已被使用，请重新发起登录。 |
| `ticket_used` | 验票 410 | 票据已被使用（一次性），请重新发起登录。 |
| `ticket_expired` | 验票 410 | 票据已过期（有效期 120 秒），请重新发起登录。 |
| `invalid_identity` | 身份缺 `uid` | 认证中心返回身份不完整，无法建立会话。 |
| `session_failed` | 写库异常 | 建立本站会话失败，请稍后重试。 |
| `verify_failed` | 网络异常 / 其它 | 与认证中心通讯失败，请稍后重试。 |
| `sso_not_configured` | 配置缺失 | 本站尚未配置统一认证中心，登录暂不可用。 |

## 7. 安全设计

1. **密钥不出服务端**：`SSO_SHARED_SECRET` 只参与服务端验票请求，响应体与静态资源均不含。
2. **票据一次性**：验票在认证中心完成，重复使用返回 `ticket_used`，本站不做票据缓存。
3. **会话安全**：Cookie `agent_site_session` = `HttpOnly` + `SameSite=Lax` + `Path=/`，HTTPS 下追加 `Secure`（依据 `x-forwarded-proto`）；数据库仅存 token 的 `sha256` 摘要，明文只在浏览器 Cookie 中。
4. **return_to 白名单**：只接受白名单 origin 的绝对 URL 或站内相对路径（拒绝 `//evil.com` 协议相对路径），未命中则记录日志并回退默认回调。
5. **权限边界**：`isAdmin` 在登录时计算落库、请求时实时重算（管理员配置变更即时生效）；写接口仅管理员，未登录 401 / 非管理员 403。

## 8. 联调步骤

1. 复制 `.env.example` 为 `.env`，填入认证中心地址与共享密钥。
2. 启动：`node .preview-server.js`（默认 2001），访问 `http://127.0.0.1:2001/`。
3. 首页滚动至末幕 → 点击「登录」→ 完成授权 → **管理员直接落到管理端**（`/admin.html`，可立即新增），**普通用户落到查询平台**（`/agents.html`），两处顶栏均提示「登录成功，欢迎回来。」；顶栏出现用户名，管理员额外显示「管理员」徽标。
4. 管理端 `http://127.0.0.1:2001/admin.html` 应放行并可新增；未登录访问显示门禁提示，非管理员显示「无管理员权限」。
5. 登出后再次访问管理端应被拦截；匿名调用写接口应返回 401。
6. 若管理员判定未命中，可在 `.env` 的 `ADMIN_SSO_UIDS` 追加认证中心 uid（逗号分隔），重启后端后重新登录即生效。

### 本地无认证中心时的验证

`utils/tests/api.test.mjs` 内置最小契约模拟认证中心（发放一次性 ticket、验票、登出），
完整跑通 SSO 往返与全部错误分支，无需真实认证中心：

```bash
node --test "utils/tests/*.test.mjs"
```

## 9. 测试覆盖索引

| 层级 | 文件 | 覆盖点 |
|---|---|---|
| 单元 | `utils/tests/unit.test.mjs` | `resolveReturnTo` 白名单、`buildSsoStartUrl/LogoutUrl`、`verifySsoTicket` 失败码映射、`normalizeIdentity` 宽松解析、`computeIsAdmin`、数据库层写入与检索 |
| 接口 | `utils/tests/api.test.mjs` | SSO 全链路（发起→验票→会话→me→登出）、票据一次性、密钥不匹配、白名单忽略、401/403/201 权限边界、输入校验、方法限制 |
| 页面 | `utils/verify/cdp-site-verify.mjs` | 首页匿名态、登录区、管理端门禁、匿名写拒绝、读接口开放、全流程零控制台错误 |
