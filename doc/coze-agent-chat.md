# 扣子对话查找与实时案例目录

验证日期：2026-10-14。

## 当前行为

查询页“对话找智能体”已调用真实扣子智能体。每次提交需求时，后端从现有 SQLite 读取最新的启用案例，再将公开目录和用户对话提供给扣子；无需另行手动更新一个外部案例知识库。

目录包含案例 ID、名称、简介、状态、学科、专业、课程、学校、标签、痛点、使用说明和扩展字段。模型返回回复、推荐 ID、匹配评分与依据，真实名称、链接及详情由本站数据库读取。停用或删除的记录不能作为推荐卡片返回；即使模型等待期间记录发生变更，返回卡片前也会再次核对当前记录。

当前目录是按原有更新时间顺序读取的前 500 条启用案例。此版本直接把目录作为模型上下文，尚未增加向量数据库或分批检索；目录规模较大或长文本较多时，应另行验证模型上下文容量。现有展示示例会在回复中明确标注示例性质，不作为真实教学成果。

## 配置与接入位置

本地 `.env` 使用 `COZE_API_TOKEN`、`COZE_BOT_ID`。密钥只由后端读取，未写入前端、示例配置或日志；`.env` 已在 `.gitignore` 中。示例配置仅提供空值。缺少任一项时，现有接口返回 503 / `ai_not_configured`。

启动命令保持不变：

```powershell
& 'C:\Program Files\nodejs\node.exe' .preview-server.js
```

后端使用扣子国内版 `https://api.coze.cn/v3/chat`。它接收流式响应，读取最终的文本回答，在 `done` 事件停止读取，再向现有前端返回完整 JSON。当前前台按整段显示回复，未增加逐字输出。

模型约定输出 `{"reply":"中文回复","recommendations":[{"id":"案例ID","matchScore":84,"matchReason":"匹配依据"}]}`。旧接入函数的 `{ reply, agentIds }` 仍可使用，但不会凭空补评分。网络失败、超时、错误事件、提前结束或无效结果统一由现有接口返回 502 / `ai_unavailable`，不透出密钥或原始上游错误。请求超时为 45 秒；外部响应上限为 1 MiB；模型回复上限为 2000 字符。

每次调用使用随机外部用户标识，不发送登录账号或访客统计。连续对话使用前台已有的有限历史记录；设置 `auto_save_history=false`，不依赖扣子会话中的旧案例目录。关闭前台对话面板会取消本地请求；后端已发出的模型调用仍受 45 秒超时限制。

协议依据：[扣子官方发起对话接口](https://docs.coze.cn/developer_guides_chat_v3)。

## 变更文件

- `.env`：本地后端凭据与 Bot ID，未展示实际值。
- `.env.example`：空白配置项与说明。
- `.preview-server.js`：按配置启用扣子接入函数。
- `project/backend/coze-agent-chat.mjs`：扣子请求、目录上下文、流式响应解析与安全错误处理。
- `project/backend/server.mjs`：每轮读取完整启用案例，并复核推荐记录。
- `project/frontend/agents.html`：将预留阶段的未接入提示改为正常查找说明。
- `utils/tests/coze-agent-chat.test.mjs`：扣子协议、最终回复、错误、超时、分片和终止事件测试。
- `utils/tests/api.test.mjs`：完整目录、后台维护即时可见、状态变更和身份隔离测试。
- `doc/query-pagination-ai.md`：更新预留接口文档的当前接入状态。

## 验证结果

首次接入验收的相关单元与接口测试 **127 项通过，0 失败**：前端 55、对话前端 6、消息校验 4、接口 49、扣子接入 13。自动化测试不调用真实扣子，不使用实际密钥。

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec utils/tests/frontend.test.mjs utils/tests/agent-chat-frontend.test.mjs utils/tests/agent-chat.test.mjs utils/tests/api.test.mjs utils/tests/coze-agent-chat.test.mjs
```

测试记录：`logs/coze-chat-tests.log`。数据库维护的验证使用临时测试库，未增加或修改生产案例。

真实联调结果：

1. 向现有 `POST /api/agents/chat` 提交“化学实验预习、学生不了解实验步骤”，返回 HTTP 200，推荐数据库中的 `demo_seed_lab-guide`，回复明确说明展示示例和能力边界。
2. PC 浏览器中发送相同需求，显示模型回复及可点击的真实案例按钮。
3. 在同一对话补充“换一个方向，需要管理学信息管理专业，整理文献阅读笔记”，模型改为推荐数据库中的 `demo_seed_research-reading`。
4. 点击第二次推荐，成功打开当前第一页之外的案例详情，展示课程、专业、学校、痛点、使用说明和真实链接。

后台维护的即时可见性由接口测试覆盖：真实 HTTP 新增/编辑/停用/启用/删除后，下一轮接入函数接收当前目录；模型等待期间停用的案例不能返回，等待期间更新的推荐卡片使用最新数据库字段。

截图目录：`utils/verify/shots/coze-chat/`。

## 手动复现

1. 打开 <http://127.0.0.1:2001/agents.html>，点击“对话找智能体”。
2. 输入痛点或学科需求，点击“发送需求”，等待回复和推荐按钮。
3. 继续补充或切换需求，确认推荐内容随需求变化。
4. 点击推荐查看完整案例，使用详情中的链接打开智能体。
5. 管理员正式保存真实案例后，新开一轮对话即可使用最新内容。填写完整痛点和能力信息；当前展示示例的链接仍是本地演示地址。

## 推荐直接打开网址（2026-10-14）

对话中的每条推荐现在显示数据库 `agentUrl` 对应的“打开智能体”按钮与网址。点击按钮在新标签打开，原对话保留；点击案例名称仍可查看完整详情。

复用现有网址校验和链接样式，允许 HTTP(S) 地址与站内路径。链接使用 `target="_blank" rel="noopener noreferrer"`；缺失或无效地址显示“暂无可用链接”，不把模型回复中的任意网址变成推荐入口。

此次只修改 `project/frontend/js/agent-chat.js`、`project/frontend/app.css`、`utils/tests/agent-chat-frontend.test.mjs` 及本说明，未改数据库或后端接口。

本次专项验证 **58 项通过**（对话前端 9、接口 49）。命令：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec utils/tests/agent-chat-frontend.test.mjs utils/tests/api.test.mjs
```

结果记录：`logs/chat-direct-links-tests.log`。覆盖绝对地址、站内路径、安全属性、危险/缺失地址、模型伪造地址不生成入口，以及链接点击不触发详情或关闭对话。接口回归验证推荐地址来自真实数据库记录。

浏览器真实发送化学实验预习需求后，“打开智能体”显示并跳转到新标签 `http://127.0.0.1:2001/agents.html?demo=lab-guide`，与数据库地址一致，原聊天保持打开。现有示例地址仍为本地演示地址；正式案例按管理员填写的实际网址跳转。

截图：`utils/verify/shots/coze-chat/direct-link.png`。

## 推荐数量与匹配评分（2026-10-14）

按用户确认，在现有聊天接口每条推荐中增加 `matchScore` 和 `matchReason`，不改数据库或接口路径。通常推荐 3–5 个相关案例，最多 5 个；符合条件的案例不足 3 个时返回实际数量，没有匹配或需要追问时可返回空列表，不填充无关案例。

模型按痛点 40 分、学科/专业/课程 25 分、功能/场景 25 分、适用对象及条件 10 分估计需求匹配程度。页面显示“匹配度 84%”等数值和具体依据，并说明这是 AI 参考评分。分数不是统计概率、成功率或已经验证的教学效果。

评分须为 0–100 的整数，依据去除首尾空白后须非空且最多 300 字符。带评分的推荐必须完整提供两项字段；无效结果返回现有 502 提示。后端去重、过滤未知或停用记录，按评分降序返回最多 5 条，名称与网址仍由真实数据库读取。前端转义匹配依据，并保留直接打开网址与查看详情功能。

本次修改文件：

- `project/backend/coze-agent-chat.mjs`：推荐数量、评分指标提示及结构化结果解析。
- `project/backend/server.mjs`：评分校验、真实案例复核、排序与数量限制。
- `project/frontend/js/agent-chat.js`：匹配度与依据展示。
- `project/frontend/app.css`：评分标识与依据样式。
- `utils/tests/coze-agent-chat.test.mjs`、`utils/tests/api.test.mjs`、`utils/tests/agent-chat-frontend.test.mjs`：对应验证。
- `doc/coze-agent-chat.md`、`doc/query-pagination-ai.md`：当前接口与复现说明。

专项测试 **82 项通过，0 失败**（接口 54、扣子接入 16、对话前端 12），记录为 `logs/chat-match-tests.log`：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec utils/tests/coze-agent-chat.test.mjs utils/tests/agent-chat-frontend.test.mjs utils/tests/api.test.mjs
```

真实 HTTP 联调输入“想提高学生课前预习和课后复习效率，帮助学生理解知识、自主学习，给我一些适合的教学智能体案例。”，返回 200、4 个真实目录示例，评分为 84、81、76、74，每条均有具体依据。模型同时明确了当前案例的展示示例性质。

PC 浏览器提交同一需求，首次出现 AI 响应失败提示，输入保留且发送按钮恢复；手动重新发送后成功。成功结果包含 4 个推荐、4 条依据及 4 个链接，匹配度依次为 88%、85%、82%、80%。所有链接均有 `target="_blank" rel="noopener noreferrer"`。点击第一项后在新标签打开 `http://127.0.0.1:2001/agents.html?demo=course-qa`，原对话保留。此次浏览器视口为 849 × 940，未增加手机端适配。

截图：`utils/verify/shots/coze-chat/match-scores.png`。外部 AI 调用仍可能失败；本次未调整原有超时及错误策略，评分功能的自动测试与真实调用分别记录。

手动复现：打开查询页并点击“对话找智能体”，提交上述需求，检查推荐数量、降序匹配度、具体依据；点击“打开智能体”检查新标签跳转。更具体的需求可能少于 3 条，实际评分会随模型回答变化。
