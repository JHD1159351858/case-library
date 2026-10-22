# 智能体前台修复交付记录（2026-10-12）

本次重新核查图片上传、字段展示、弹窗样式和链接跳转。接手时项目已具备四项基础实现；以下记录本轮实际修复和重新验证结果。本文末尾的 2026-09-22 内容作为历史记录保留，其测试结论不代表当前状态。

## 本轮问题与修复

**图片上传：** multipart 解析原先按裸 `--boundary` 查找分隔符。合法 GIF 的注释区包含类似字符串时，163 字节图片被截成 47 字节；POST 仍返回 201 和 URL，GET 返回 200 却已丢失图片内容。修复后只认可位于行首且有合法结尾的完整分隔符。同时补齐 GIF/WebP 的响应 MIME 类型。单元和接口测试比较原始字节，真实 Chrome 对 PNG/GIF/WebP 验证了解码与预览。

管理端增加上传中提交阻断，避免上传未返回 URL 就保存无封面的记录。后选图片、清空、取消编辑、切换编辑、清除或手输封面使旧上传失效；迟到响应不能回填当前表单。失败保持原有封面，显示中文提示并恢复提交。

**字段展示：** 表单、模型和接口原已有全部业务字段。残留问题是详情失败后静默显示“暂无描述/暂无说明”，以及同名记录通过标题判断请求归属，慢响应可能覆盖另一条记录。现在按 ID 和请求代次隔离响应；加载中明确提示等待，失败显示“详情未加载”和重试按钮，成功后展示真实长文本与扩展字段。两页扩展 JSON 的 `null` 明确显示为 null，`0`、`false` 和嵌套对象保持可见。

**弹窗样式：** 沿用已经实现的前台规范：主色 `#00ffd1`、次级青色 `#5fe9ff`、暗色背景、既有圆角。PC 实测标题 24px、正文 16px、辅助 13.6px；手机标题 21.12px、正文 15.68px。弹窗内紫色文字节点为 0。关闭按钮和链接的 hover、过渡与点击反馈正常。1440px PC、834px 平板、390px 手机均无页面横向溢出；手机采用底部抽屉和单列键值布局，截图已检查。本轮无需额外修改 CSS。

**链接跳转：** `agentUrl` 已存在于模型、表单和接口，无需新增或重命名。前后端旧校验仅检查前缀，`https://` 能保存却无法解析。现在使用真实 URL 解析，并拒绝危险协议、协议相对地址、反斜杠和 ASCII 控制字符。合法 http(s) 地址及站内路径保留原值。卡片/弹窗链接均保留 `target="_blank" rel="noopener noreferrer"`；真实点击验证了新标签和目标页加载。

## 本轮变更文件

- `project/backend/server.mjs`：multipart 边界、GIF/WebP 响应类型、URL 校验。
- `project/frontend/js/session.js`：与后端一致的智能体链接校验。
- `project/frontend/js/agents.js`：详情竞态隔离、加载/失败/重试状态、null 展示。
- `project/frontend/js/admin.js`：上传状态、提交阻断、过期上传隔离、null 展示。
- `utils/tests/unit.test.mjs`：新增图片完整性和非法链接单元回归。
- `utils/tests/frontend.test.mjs`：新增 17 项 Node 内置 VM 行为测试，无新依赖。
- `utils/tests/api.test.mjs`：GIF/WebP 回读、POST/PUT 链接校验、校正过期检索断言。
- `utils/verify/cdp-agent-fix.mjs`：专项验证扩充至 50 项、请求响应记录、隔离路径支持；弹窗链接先滚入视口再真实点击。
- `doc/agent-frontend-fixes.md`：本轮交付说明。

未变更数据库结构、字段名、接口路径、目录结构或依赖；未对业务数据库执行写入测试。`agentUrl` 从保存到列表/详情响应再到前台渲染已验证。

## 本轮验证结果

- 单元测试 **58/58**（后端/数据层 41，前端 17）。
- 真实 HTTP 接口测试 **28/28**，覆盖上传、权限、类型、大小、字段往返、更新和既有 SSO 流程。
- 智能体专项真实 Chrome 验证 **50/50**。
- 既有站点 Chrome 回归 **27/27**，覆盖首页、管理员门禁、新增/检索、详情关闭、匿名读写权限。
- 专项全程无未处理 JavaScript 异常，PC/平板/手机截图通过检查。

新增问题测试先在旧实现上失败，再在修复后通过。初始 64 项 Node 测试有 1 项失败：过期断言要求 `data_json` 参与检索，但当前查询范围仅业务字段。本轮改为验证独立的课程名称检索及返回值，未扩展搜索功能。

接口实测：合法上传 → 201，图片 GET → 200 且字节一致；HTML 假图片 → `400 {"error":"invalid_image_data"}`；超过 3 MB → `413 {"error":"file_too_large"}`；无效链接 → `400 {"error":"invalid_agent_url"}`。浏览器中的慢响应和一次网络失败采用受控延迟/注入，恢复后仍使用真实后端接口。

测试日志有 Node 自带 SQLite 实验性提示，以及既有接口测试反复启动服务产生的 SIGINT/SIGTERM 监听器数量提示；失败数为 0。本轮未扩展服务生命周期改动。

## 本轮可复现步骤

项目根目录运行单元与接口测试，预期 86 项通过、0 项失败。接口测试自动使用临时库和模拟认证中心并清理。

```powershell
node --test "utils/tests/*.test.mjs"
```

浏览器验证终端 A：建立隔离目录并启动后端，保持终端运行。2011 和 9222 端口需空闲。

```powershell
$verifyRoot = Join-Path $PWD 'utils\verify\shots\agent-fix-current'
New-Item -ItemType Directory -Force -Path (Join-Path $verifyRoot 'database') | Out-Null
$env:DB_PATH = Join-Path $verifyRoot 'database\test.db'
$env:UPLOADS_DIR = Join-Path $verifyRoot 'database\uploads'
node --input-type=module -e "import { startPreviewServer } from './project/backend/server.mjs'; startPreviewServer({ port:2011, host:'127.0.0.1', appPublicUrl:'http://127.0.0.1:2011', ssoCenterUrl:'', ssoSharedSecret:'', adminRoles:'admin', dbPath:process.env.DB_PATH, uploadsDir:process.env.UPLOADS_DIR });"
```

终端 B：使用独立无界面 Chrome 执行专项验证，预期 50/50。脚本建立一次性测试管理员会话，结束时清理本次记录、会话、用户和上传文件。

```powershell
$verifyRoot = Join-Path $PWD 'utils\verify\shots\agent-fix-current'
$env:DB_PATH = Join-Path $verifyRoot 'database\test.db'
$env:UPLOADS_DIR = Join-Path $verifyRoot 'database\uploads'
$env:VERIFY_OUT_DIR = Join-Path $verifyRoot 'final'
$agentBrowser = Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList @('--headless=new', '--disable-gpu', '--remote-debugging-port=9222', "--user-data-dir=$verifyRoot\chrome-profile", 'about:blank') -WindowStyle Hidden -PassThru
node utils/verify/cdp-agent-fix.mjs http://127.0.0.1:2011
```

验证结束后在终端 A 按 Ctrl+C，关闭本次启动的 Chrome。正式服务应用后端修复时需重启加载最新代码；若正式库需要执行既有迁移，应先确认具体结构变更。

人工复核：上传中不能提交，成功后图片回显；非法格式/假图片/超限显示中文提示且可重试；填写所有字段保存后核对详情；切换同名记录不串内容；详情请求失败可重试；卡片与弹窗链接真实打开新标签；平板/手机文字与滚动正常。

本轮证据位于原有忽略目录 `utils/verify/shots/agent-fix-current/`：`node-tests.log` 为 86 项测试日志，`final/report.json` 包含 50 项断言和接口方法/路径/状态码/返回体（无认证 Cookie），`final/01~08-*.png` 为截图，`site/report.json` 为 27 项站点回归。`site-verify-isolated.mjs` 是既有站点脚本的隔离副本，仅替换数据库和产物路径。测试记录与会话已清理。

---

# 历史记录：前台智能体展示与交互修复（2026-09-22）

> 项目路径：D:\Crow5\Project\agent-official-website
> 范围：智能体查询平台（前台）+ 管理端 + 智能体接口/上传接口
> 日期：2026-09-22
> 验证脚本：`utils/verify/cdp-agent-fix.mjs`（新增）、`utils/verify/cdp-site-verify.mjs`（回归）

## 一、问题与根因

| # | 现象 | 根因 | 修复 |
|:--:|---|---|---|
| 1 | 图片上传失效（选择图片后提示上传失败） | **后端是旧进程**：线上 2001 端口的进程启动于代码更新之前，路由表里没有 `POST /api/uploads`，前端请求命中兜底分支返回 `404 not_found` | 重启后端加载最新代码；上传接口补充文件内容（魔数）校验；超限响应改为可读的 413；前端补齐失败文案与类型前置校验 |
| 2 | 已填写字段前台不展示 | **同一根因**：旧进程不认识 `discipline / major / courseName / agentUrl / schoolName / coverImage / painPoint / usageGuide`，写入时被静默丢弃，数据库也没有这些列（`ALTER TABLE` 迁移随启动执行，旧进程从未执行过） | 重启后端触发既有迁移补齐 8 个业务列；接口层补充「提交后回查」防呆，字段被丢弃时显式提示 |
| 3 | 智能体弹窗字号偏小、紫色配色不适用 | `app.css` 弹窗区域字号基准偏小（分区标签 0.64rem、正文 0.86rem）；次级强调色 `--accent-violet: #c77dff` 被用于弹窗内的分区标签 / 卡片眉标 / 统计徽标 | 重建弹窗字号层级；次级强调色由紫色系改为首页同源青系；补齐 hover / active / focus / 过渡动画与三档响应式 |
| 4 | 前台缺少智能体链接字段、无法点击跳转 | 数据模型与接口本就有 `agentUrl`（`agents.agent_url`），但前台**只在弹窗里以纯文本形式渲染**，且列表卡片是 `<button>` 容器（内部不允许嵌套链接），列表页完全看不到链接 | 卡片由 `<button>` 改为 `role="button"` 容器，新增「打开智能体」链接；弹窗改为链接主按钮 + 地址说明；统一 `target="_blank"` + `rel="noopener noreferrer"` |

> 说明：问题 1、2 的根因是**运行态与代码不一致**（旧进程 + 未迁移的库），不是字段名或绑定错误。
> 本次未改动数据库结构、字段名与接口路径：迁移由后端启动时的既有逻辑（`migrateAgentColumns`）执行，仅做 `ALTER TABLE ADD COLUMN`（带默认值、非破坏性）。

## 二、变更文件清单

### 后端

| 文件 | 变更 |
|---|---|
| `project/backend/server.mjs` | ① `readJsonBody` / `readRawBody` 超限时不再 `request.destroy()`，改为消费剩余数据后回传响应（否则前端拿到连接中断而非 413 提示）；② 新增并导出 `sniffImageMime()`，上传按文件头校验「内容真的是图片」，落盘扩展名以实际内容为准；③ 导出 `extractUploadFile()`、`agentSummary()`、`agentDetail()` 供单元测试直接断言 |

### 前端

| 文件 | 变更 |
|---|---|
| `project/frontend/app.css` | 弹窗字号层级与配色重构；次级强调色紫色系 → 青系（`--accent-cyan`）；新增 `.modal-head-text / .modal-subtitle / .detail-link / .detail-link-btn / .detail-link-url / .agent-card-actions / .agent-link`；平板 / 手机断点（手机为底部抽屉式弹窗、键值表单列）；统一 hover / active / focus-visible / 过渡 |
| `project/frontend/agents.html` | 弹窗头部增加副标题容器（标题 / 副标题 / 正文三级） |
| `project/frontend/admin.html` | 同上（管理端复用同一弹窗样式） |
| `project/frontend/js/session.js` | 新增 `resolveAgentLink()`（与后端 `normalizeAgentUrl` 同规则的链接归一，`javascript:` 等危险协议在前端二次拦截）与 `renderAgentLink()`（弹窗链接块） |
| `project/frontend/js/agents.js` | 卡片改为 `role="button"` 容器并新增「打开智能体」链接（链接点击不触发详情弹窗，支持 Enter / Space 打开详情）；弹窗链接改为主按钮 + 地址；新增弹窗副标题 |
| `project/frontend/js/admin.js` | 上传：类型 / 空文件 / 大小前置校验 + 分状态中文失败文案（404 提示「后端可能仍是旧进程」）+ 显式文件名；提交：新增 `droppedFields()` 提交后回查，字段未落库时给出警告提示；修正成功提示被 `resetForm()` 清空的问题；明细弹窗改用链接主按钮 + 副标题 |

### 测试与验证

| 文件 | 变更 |
|---|---|
| `utils/tests/unit.test.mjs` | 新增 5 个用例：危险协议拒绝、表单字段 → 归一全接收、列表 / 详情响应字段全覆盖、multipart 解析、图片魔数识别 |
| `utils/tests/api.test.mjs` | 新增 7 个用例：上传成功并可原样取回、上传权限与内容校验（401/403/415/400）、3 MB 超限 413 响应可读、JSON 超限 413 响应可读、字段完整性往返、链接字段校验、封面替换回收 + 未提交字段保值；测试环境新增 `uploadsDir` 隔离，避免污染 `database/uploads` |
| `utils/verify/cdp-agent-fix.mjs` | **新增**：40 项真实浏览器断言（上传 / 字段 / 弹窗样式 / 链接跳转 / 三档响应式）+ 截图 + `report.json`，运行结束自动清理测试数据 |
| `utils/verify/cdp-site-verify.mjs` | 修复 3 处过期断言（提交按钮 id 由 `create-submit` → `form-submit`；名称单元格含副标题后需按去空白首行比对），使既有回归脚本恢复可用 |
| `.gitignore` | 忽略 `utils/verify/chrome-profile*/`（浏览器调试配置目录） |

## 三、验证步骤（可复现）

### 1. 启动后端（**必须重启**，否则仍是旧进程）

```bash
node .preview-server.js          # 127.0.0.1:2001
```

启动日志应包含 `封面上传  …/database/uploads` 一行；该行存在即说明已是最新代码（旧版本没有这一行）。

### 2. 单元 + 接口测试

```bash
node --test "utils/tests/*.test.mjs"
```

若环境禁止 Node 测试运行器派生子进程（报 `spawn EPERM`），改用同进程模式：

```bash
node --test --experimental-test-isolation=none "utils/tests/*.test.mjs"
```

### 3. 浏览器验证（真实 Chrome）

```bash
# 1) 以调试端口启动 Chrome
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=<临时目录> about:blank

# 2) 本轮 4 项修复的专项验证（40 项断言 + 7 张截图）
node utils/verify/cdp-agent-fix.mjs

# 3) 站点全链路回归（27 项断言）
node utils/verify/cdp-site-verify.mjs
```

产物：`utils/verify/shots/agent-fix/`（`report.json` + 01~07 截图）、`utils/verify/shots/site/`。
两个脚本都会向数据库写入一次性验证会话并在结束时清理，不残留测试数据。

### 4. 人工复核建议

1. 管理端选择图片 → 预览立即回显、状态显示「已上传」、提示条给出站内地址；
2. 管理端填写全部字段提交 → 打开 `/agents.html`，卡片应显示封面、学科 / 专业 / 课程 / 学校、标签与「打开智能体」链接；
3. 点击卡片 → 弹窗展示简介 / 链接 / 痛点 / 使用说明 / 记录信息 / 扩展字段，点击「打开智能体」在新标签打开真实地址；
4. 浏览器缩放或切到手机宽度（≤560px）→ 弹窗变为贴底抽屉、键值表单列、无横向滚动条。

## 四、验证结果（本轮）

### 单元 + 接口测试

| 项 | 结果 |
|---|---|
| 用例总数 | 64 |
| 通过 | 63 |
| 失败 | 1（**既有问题，与本轮改动无关**，见下） |

失败用例：`权限：未登录写入 401，管理员写入 201 并可检索到` → 其中一句断言「扩展字段应参与检索」失败。
关键词检索 SQL（`database.mjs` 的 `AGENT_FILTER_SQL`，本轮未改动）只覆盖业务字段，不含 `data_json`；
而管理端对扩展字段的说明是「键值对会直接展示在查询平台详情中」（展示，不承诺检索），查询平台搜索框占位文案也未提及扩展字段。
实测证据：用未改动的 `database.mjs` 写入一条 `data_json` 含「答疑」的记录，`q=答疑` 命中 0 条、`q=课程`（业务字段）命中 1 条。

处理建议（二选一，均为一处改动，请确认后执行）：
- 若扩展字段**应当**可检索：在 `AGENT_FILTER_SQL` 增加 `OR data_json LIKE :pattern ESCAPE '\\'`；
- 若维持现状：把该断言的验证目标改为业务字段（例如检索 `课程`）。

### 浏览器验证

| 脚本 | 结果 |
|---|---|
| `cdp-agent-fix.mjs`（本轮 4 项修复专项） | **40 / 40 通过**，全流程 0 控制台错误 |
| `cdp-site-verify.mjs`（站点全链路回归） | **27 / 27 通过**，全流程 0 控制台错误 |

关键实测数据（来自 `utils/verify/shots/agent-fix/report.json`）：

- 上传：`/uploads/1790090892733_7cd9241d.png`，前台取回 `200 image/png` 且字节与上传完全一致；假图片（HTML 改名 .png）→「文件内容不是有效图片」；`.bmp` →「不支持的图片格式（image/bmp）」。
- 字段：接口列表返回 `discipline/major/courseName/schoolName/agentUrl/coverImage` 全部命中表单填写值；卡片渲染「学科 工学 / 专业 计算机科学与技术 / 课程 数据结构与算法 / 学校 示例大学」。
- 弹窗字号（PC）：标题 24px > 正文 16px > 键名 13.6px > 分区标签 12.48px；手机（390px）：标题 21.12px、正文 15.68px。
- 弹窗配色：分区标签实测 `rgb(0, 255, 209)`（青绿主色）；弹窗内紫色系文字节点数 **0**。
- 链接：卡片与弹窗均为 `target="_blank" rel="noopener noreferrer"`；真实鼠标点击后新标签打开目标地址且目标页加载完成；点卡片链接不会误开详情弹窗。
- 响应式：平板 834px 卡片两列；手机 390px 卡片单列、弹窗贴底（bottom = 视口底部）、键值表单列；各档 `scrollWidth == innerWidth`（无横向溢出）。

## 五、遗留与建议

1. **服务重启是本次修复的必要步骤**：前端静态资源即时生效，但后端进程必须重启。后续若再次出现「填了不显示 / 上传失败」，先看启动日志有没有 `封面上传` 一行。
2. 上述 1 个既有失败用例待确认（见第四节）。
3. 前端上传做了 MIME 前置校验，服务端按文件头二次校验；如需支持更多格式（如 SVG / AVIF），需同时改 `COVER_MIME_EXTENSIONS`、`sniffImageMime` 与 `admin.js` 的 `COVER_MIME_EXTENSIONS` 三处。
