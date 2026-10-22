# 智能体浏览统计说明与验证记录

实施日期：2026-10-12。当前本地服务已启用，入口：<http://127.0.0.1:2001/admin.html>。

## 使用方式与统计口径

管理端的每条智能体记录新增「浏览人数 / 次数」。点击数字可查看访客姓名、浏览次数、首次浏览时间和最近浏览时间，支持分页；点击「刷新」获取最新统计。

- 登录人数按账号去重，同一账号反复查看仍为 1 人，浏览次数继续累计。
- 匿名访客按浏览器 Cookie 去重，单独显示数量；清除 Cookie 或换浏览器会产生新的匿名访客。匿名数量不代表实际人数，也不与登录账号合并。
- 前台成功打开案例详情才记录。加载失败、关闭后才返回的请求、离线示例展示以及管理员访问均不计入。
- 浏览次数包含普通登录用户与匿名访客的浏览。管理端读取案例、查看浏览明细和刷新列表不增加次数。
- 统计从功能启用后开始累计，没有可补录的历史浏览记录。当前项目原有 9 条案例保留，初始统计为 0。
- 浏览明细仅管理员可读；普通用户和未登录访客不能获取明细。公开列表不包含统计或访客身份。

## 数据与接口

经用户确认，新增 `agent_views` 表，按案例和访客身份保存累计次数及首次、最近时间。登录访客关联现有用户，匿名访客使用服务端生成的 Cookie 标识摘要。原案例字段和已有接口路径未修改，浏览记录不会改变案例更新时间。

- `POST /api/agents/:id/views`：记录一次浏览，由服务端识别账号或匿名访客。管理员返回 `recorded: false`，跨源请求拒绝。
- `GET /api/agents/:id/views?limit=20&offset=0`：管理员读取汇总与分页明细，返回 `viewStats`、`items`、`total`、`limit`、`offset`。
- 管理员读取原 `GET /api/agents` 时，每条记录新增 `viewStats`，包含 `userCount`、`anonymousCount`、`viewCount`。
- 明细展示字段为 `visitorType`、`displayName`、`viewCount`、`firstViewedAt`、`lastViewedAt`；不返回会话、SSO 标识或匿名访客键。

启动时幂等创建新表。启用前已备份数据库：`database/backups/agent-website-before-views-20261012.db`。

## 本次变更文件

- `database/schema.sql`：浏览记录表及索引。
- `project/backend/database.mjs`：累计、去重、批量汇总及分页读取。
- `project/backend/server.mjs`：记录接口、管理员明细接口和权限控制。
- `project/frontend/js/agents.js`：成功展示详情后记录浏览。
- `project/frontend/js/admin.js`：列表数字、访客明细、分页、重试及异步请求保护。
- `project/frontend/admin.html`、`project/frontend/app.css`：统计列与明细布局。
- `utils/tests/views-unit.test.mjs`、`utils/tests/api.test.mjs`、`utils/tests/frontend.test.mjs`：新增回归与功能测试。
- `utils/verify/admin-table-layout.js`：兼容新增统计列的操作列检查。
- `utils/verify/view-analytics-fixture.mjs`：独立临时数据库的浏览器联调工具，不写入当前项目数据。
- `utils/verify/shots/view-analytics/`：截图和脱敏验证结果。

未增加依赖，保持现有 HTML/CSS、JavaScript、Node 与 SQLite 技术栈。

## 测试结果

执行命令（项目根目录）：

```powershell
& 'C:/Program Files/nodejs/node.exe' --test --test-reporter=dot utils/tests/unit.test.mjs utils/tests/views-unit.test.mjs utils/tests/frontend.test.mjs utils/tests/api.test.mjs
```

105 项通过、0 项失败：数据库及后端单元测试 47 项，前端测试 24 项，接口测试 34 项。新增测试先复现未实现时的失败，再验证实现后通过，覆盖去重、重复计数、权限、匿名 Cookie、分页、跨源拒绝、存量数据库重启、详情加载失败与异步请求切换。

浏览器联调使用独立临时案例及测试账号：匿名浏览两次、同一普通账号浏览两次，得到登录人数 1、匿名访客 1、浏览次数 4；管理员再访问，次数保持 4。明细显示测试账号姓名、每位访客各 2 次浏览和首次、最近时间。390 × 844 手机视口的弹窗无横向溢出。

当前服务核验：原有 9 条案例正常加载，空记录显示「暂无浏览记录」，统计为 0；1065 × 1244 视口表格 8 项检查全部通过，包括名称宽度、表头对齐、状态单行、操作按钮完整和页面无横向溢出。

截图：`admin-live.png` 为当前管理端；`detail-desktop.png`、`detail-mobile.png` 为独立测试环境的明细。结果文件：`utils/verify/shots/view-analytics/report.json`。浏览器测试会话及工作区内的临时会话文件已清理，独立测试服务已停止；系统临时目录中的测试数据库保留，未写入当前项目数据库。

## 可复现的人工验证

1. 普通账号在查询平台打开任意案例详情，关闭后再打开；管理员刷新列表，该账号对应人数只增加 1，次数增加 2。
2. 在未登录的浏览器打开同一案例两次；管理员刷新后，匿名数量增加 1，次数增加 2。
3. 管理员点击该行统计数字，检查访客姓名、次数和首次、最近时间；超过 20 条记录时检查分页。
4. 管理员从查询平台打开案例、查看后台案例详情或浏览明细，刷新后次数保持不变。
5. 断开服务后打开案例，确认失败提示正常；恢复服务后重新打开，确认只有成功展示才记录。
6. 手机视口查看明细，检查弹窗内容可滚动、关闭按钮可操作，表格可在容器内横向滚动而页面不溢出。

验证时使用新增访问的差值，不清空现有统计。当前账号如果具有管理员权限，需要普通账号或未登录浏览器才能产生浏览记录。
