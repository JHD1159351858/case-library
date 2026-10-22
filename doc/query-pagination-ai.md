# 查询平台：字号、分页与对话接口

本页记录 2026-10-13 的分页与预留接口验收。2026-10-14 已接入扣子，当前接入方式和验证结果见 [扣子对话接入](coze-agent-chat.md)。服务地址：<http://127.0.0.1:2001/agents.html>。

## 已实现

- 卡片继续只展示专业和学校，内容字号为 16px，字段标签为 14px，文字保持白色。管理端效果预览使用相同卡片字号。
- 每页 6 条，沿用 `GET /api/agents` 的 `limit` 和 `offset` 参数，显示当前页、真实总数和条目范围。
- 搜索、重置、学科/学校/状态筛选与清空筛选回到第一页。末页不可继续向后翻，列表缩减时自动加载合法页，迟到请求不会覆盖当前列表。
- 热门 TOP 3 继续按全库累计浏览次数计算，翻页或筛选不会产生新的热门排名。
- 标题右侧增加“对话找智能体”，点击打开右侧对话面板。失败时保留输入，关闭时取消在途请求，支持 Escape 关闭。
- 已按用户确认新增 `POST /api/agents/chat`，预留后端模型接入函数与前端多轮对话、推荐案例打开逻辑。

2026-10-13 验收时未配置外部 AI，接口返回 HTTP 503 / `ai_not_configured`。2026-10-14 已支持读取后端扣子配置；缺少配置时仍保留该明确提示。两次改动均未修改数据库结构、字段名或安装依赖。

## 对话接口约定

请求为 JSON：

```json
{
  "messages": [
    { "role": "user", "content": "需要帮助学生预习化学实验的智能体" }
  ]
}
```

消息数量 1–20 条，仅接受 `user` / `assistant`，每条去除首尾空白后为 1–2000 个字符，最后一条必须为用户消息。请求体上限沿用现有 64 KiB 限制。额外身份字段不会传入模型。浏览器跨源请求拒绝为 HTTP 403。

接入成功后的响应：

```json
{
  "reply": "模型给出的回复",
  "items": []
}
```

`items` 使用现有公开案例摘要结构。后端按模型返回的案例 ID 读取真实记录，过滤未知 ID、去重，最多返回 5 条。2026-10-14 经用户确认增加 `matchScore`（0–100 整数）和 `matchReason`（非空匹配依据，最多 300 字符），按分数降序展示。通常推荐 3–5 个相关案例，不足时返回实际数量。前台点击推荐后再读取真实详情，支持打开当前分页之外的案例，也可直接点击数据库中的网址。

接入位置为 `project/backend/server.mjs` 的 `startPreviewServer(overrides, { agentChatProvider })`。`agentChatProvider({ messages, agents })` 返回 `{ reply, agentIds, recommendations }`，其中 `recommendations` 为 `{ id, matchScore, matchReason }` 列表。旧接入函数可省略该列表，前端不会补造评分。2026-10-14 起，`agents` 为前 500 条启用案例的完整公开详情，包含痛点、使用说明和扩展字段，不包含访客明细或登录身份。启动入口已根据 `.env` 中的扣子配置传入接入函数。

错误返回：未接入为 503 / `ai_not_configured`；消息无效为 400 / `invalid_messages`；模型调用失败或响应无效为 502 / `ai_unavailable`。后端异常不向客户端返回密钥、错误堆栈或模型原始错误。

## 修改文件

- `project/frontend/agents.html`：分页与对话入口、面板结构。
- `project/frontend/app.css`：专业/学校字号、分页及对话面板样式。
- `project/frontend/js/agents.js`：服务端分页、全库热门排名与跨页推荐详情集成。
- `project/frontend/js/agent-chat.js`：对话提交、上下文、失败提示、取消与推荐点击。
- `project/backend/server.mjs`：已确认的聊天接口与模型接入位置。
- `utils/tests/frontend.test.mjs`：分页、请求竞争与跨页详情测试。
- `utils/tests/api.test.mjs`：聊天接口与现有接口回归。
- `utils/tests/agent-chat.test.mjs`：消息规范化与校验。
- `utils/tests/agent-chat-frontend.test.mjs`：对话交互、输入保留、转义、历史和取消测试。

## 验证结果与复现

自动测试共 **112 项通过，0 失败**：前端 55、对话前端 6、对话校验 4、接口 47。接口测试使用临时数据库和测试接入函数；它们验证接入契约，不代表当前服务已经连接 AI。

在项目根目录执行：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec utils/tests/frontend.test.mjs utils/tests/agent-chat-frontend.test.mjs utils/tests/agent-chat.test.mjs utils/tests/api.test.mjs
```

原始结果：`logs/query-pagination-ai-tests.log`。

浏览器验证使用当前 PC 视口 1273 × 1244，未增加手机端适配：

1. 刷新查询页：当前 9 条案例，第一页显示 6 张卡片；上一页禁用，显示“第 1 / 2 页 · 共 9 条 · 显示 1–6 条”。实际计算样式为内容 16px、标签 14px、白色。
2. 点击下一页：显示剩余 3 张卡片，页码为 2 / 2，范围 7–9，下一页禁用；这些案例没有被重新标记为热门。
3. 从第二页搜索“问答”：显示 2 条匹配记录，页码回到 1 / 1。重置后再次翻到第二页，选择工学：显示 2 条记录并回到第一页。
4. 清空筛选后搜索“没有匹配案例_分页验证”：显示无结果提示，分页隐藏。点击重置恢复第一页。
5. 第二页点击“文献阅读整理助手（示例）”：成功读取并展示完整详情、标签、课程与链接。
6. 点击“对话找智能体”，输入化学实验需求并发送：显示“AI 尚未接入”，原始输入保留，发送按钮恢复可用，没有生成模拟回复或推荐。
7. 按 Escape：对话关闭，焦点返回入口，页面滚动恢复。

运行中的服务 `/api/health` 返回 200；真实聊天请求返回 503 / `{"error":"ai_not_configured"}`。本次浏览器警告/错误日志检查为空。服务已重新启动以加载新增接口。

截图：

- `utils/verify/shots/query-pagination-ai/desktop.png`：第一页、放大后的专业/学校与对话入口。
- `utils/verify/shots/query-pagination-ai/pagination-page2.png`：第二页内容、范围与边界按钮。
- `utils/verify/shots/query-pagination-ai/chat-placeholder.png`：未接入提示和保留的输入。
