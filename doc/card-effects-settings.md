# 管理端卡片效果参数

## 使用方法

管理员在记录区点击“卡片效果”。弹窗左侧实时预览，右侧可拖动滑条或输入数值，点击颜色块分别修改三个热门排名的颜色。点击“保存并应用”发布到全站；“恢复默认”先恢复预览，需要再次保存才发布。

- TOP 1、TOP 2、TOP 3 火焰颜色分别独立设置，默认紫、橙、绿；高光自动匹配浅色。
- 共用参数为画布透明度、整体亮度、高光强度、流动速度、消散速度、纹理尺度、脉络强度、纵向范围、横向范围、鼠标影响范围、垂直位置、鼠标拉动强度和摆动角度。
- “消散速度”范围 0–3，控制火焰上升后的透明度衰减；值越大，上方火焰越快淡出，0 保留原始效果。它与流动速度独立，不控制鼠标离开后的恢复速度。
- 预览可切换三个排名，连续调节复用同一画布；关闭弹窗释放预览资源。
- 卡片底色为纯黑，标题、正文与辅助文字为纯白，去掉悬停时模糊叠加层；保留火焰、边框流光和摆动。卡片信息只展示专业与学校，标签在详情中查看。仅针对桌面端调整。

## 全站保存

用户已确认新增独立配置表及接口；仅保存样式配置，不改智能体记录：

```sql
CREATE TABLE IF NOT EXISTS card_effect_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

新增同一个接口路径的读写方法：

- `GET /api/card-effects`：所有访客可读取已发布的效果配置；未保存时返回默认配置。
- `PUT /api/card-effects`：仅登录管理员可保存；校验参数、颜色、请求来源和权限，保存成功后供前台读取。

配置 JSON 包含：`flame1`、`flame2`、`flame3`、`opacity`、`brightness`、`highlight`、`speed`、`decaySpeed`、`scale`、`branch`、`vext`、`hext`、`radius`、`posy`、`hoverStrength`、`tilt`。旧配置读取时自动补 `decaySpeed: 0`，不改原存储或更新时间；保存时提交完整 16 项。新增参数沿用现有配置表和接口路径。

保存后新打开或刷新的查询页使用配置；服务重启后保留。管理员调节时先实时预览，点击“保存并应用”才发布。

读取失败时禁用保存并提供重试，避免覆盖尚未读取的全站配置。保存时防止重复提交；保存失败保留当前调节并显示提示。未发布的调节在当前页面关闭弹窗后仍保留，刷新页面重新读取已发布配置。

## 验证结果

单元测试与前端回归 78 项，接口测试 41 项，数据库测试 3 项，共 122 项通过。覆盖三色独立、参数边界、消散实时更新不重建画布且不影响流动速度、旧配置兼容、读写失败、保存期间重复提交、权限与来源校验、服务关闭后重新连接数据库保留配置，以及原有上传、字段、链接、浏览统计和表单流程。新增卡片测试确认只显示专业与学校、不显示标签，详情仍展示学科、课程与标签。

复现测试命令（Node 22）：

```powershell
node --test --test-reporter=spec utils/tests/card-effects-admin.test.mjs utils/tests/frontend.test.mjs utils/tests/card-effect-settings.test.mjs utils/tests/shader-card.test.mjs utils/tests/card-effects-db.test.mjs utils/tests/api.test.mjs
```

三色功能的桌面浏览器验证步骤与结果：

1. 管理端打开“卡片效果”，读取全站配置；颜色块、数值框与滑条均可操作。
2. 分别将三色改为 `#7d3cff`、`#ff6b1a`、`#0dcf9c`，透明度改为 `0.92`，亮度改为 `1.1`，切换 TOP 3 检查实时预览。
3. 点击“保存并应用”，出现发布成功提示；刷新管理端重新打开，三色、透明度和亮度均读回相同值。
4. 刷新查询页，9 条案例正常显示，三个热门画布透明度均为 `0.92`，各排名渲染对应颜色。
5. 验证后恢复默认并再次保存；查询页已刷新为明亮默认三色，三个画布透明度均为 `1`。两页控制台均无警告或错误。

截图：`utils/verify/shots/shader-glass/admin-parameters.png`（三色面板）、`admin-parameters-published.png`（发布成功）、`desktop.png`（查询页）。本次按用户要求只验证桌面端。

本次新增消散速度与卡片调整验证：

1. 管理端“卡片效果 → 流体形态”显示消散速度滑条、数值输入及说明。
2. 输入 `1.2` 后保存，刷新重新打开，数值与滑条均回读 `1.2`；查询页刷新后，火焰上部淡出而底部保留。
3. 验证后仅把消散速度恢复为原值 `0` 并保存；逐项比对确认管理员之前保存的颜色、亮度、流动速度等参数均保留。
4. 查询页全部 9 张卡片正常显示，卡片标签数为 0，元信息只有“专业”和“学校”。标题、正文、元信息和状态时间的计算颜色均为 `rgb(255, 255, 255)`，卡片底色为 `rgb(0, 0, 0)`。
5. 鼠标悬停仍有倾斜反馈，模糊叠加伪元素为 `none`，火焰正常渲染。截图：`utils/verify/shots/shader-glass/admin-decay-speed.png`、`cards-bright-black.png`。

本次直接改动：`project/frontend/app.css`、`admin.html`、`js/agents.js`、`js/card-effects-admin.js`、`js/card-effect-settings.js`、`js/shader-card.js`；测试涉及 `utils/tests/frontend.test.mjs`、`card-effects-admin.test.mjs`、`card-effect-settings.test.mjs`、`shader-card.test.mjs`、`api.test.mjs`。无需新增依赖或数据库迁移。

## 变更文件

- `project/frontend/admin.html`、`project/frontend/app.css`：卡片效果入口、弹窗与控件样式。
- `project/frontend/js/admin.js`、`card-effects-admin.js`：管理员预览、读取与发布。
- `project/frontend/js/card-effect-settings.js`、`shader-card.js`、`agents.js`：共享参数、独立排名颜色和前台读取。
- `database/schema.sql`、`project/backend/database.mjs`、`project/backend/server.mjs`：独立配置表与读写接口。
- `utils/tests/card-effect-settings.test.mjs`、`card-effects-admin.test.mjs`、`shader-card.test.mjs`、`frontend.test.mjs`、`card-effects-db.test.mjs`、`api.test.mjs`：参数、预览、前台、数据库与接口验证。
