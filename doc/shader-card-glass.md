# 查询页玻璃背景与热门卡片

## 展示规则

- 热门卡片按全库累计浏览次数取前 3 名；次数相同按更新时间倒序，再按 ID 排序。搜索和筛选不会重新定义热门排名，也不会改变原有列表顺序。
- 次数来自现有浏览统计。零次浏览按真实值显示；接口不可用时不伪造排名或次数。
- 热门卡片使用用户提供的 `D:/Chrome/Shader Card 复刻.html` 中的片元 Shader：域扭曲流体、细亮纹理、光标牵引。TOP 1、TOP 2、TOP 3 默认分别为紫色、橙色、绿色，高光自动匹配浅色。默认透明度、亮度、高光强度均恢复为 1，画布继续位于文字下方；管理端提供独立三色及其他参数实时预览。保留案例封面、字段和链接。
- 所有案例卡片随鼠标上下、左右倾斜，最大约 8 度，移开后平滑回正。触屏不启用鼠标倾斜；减少动态设置使用静态 Shader；画布不拦截点击。
- 查询页背景使用移动的蓝紫、粉橙渐变与大色块；玻璃表面采用低透明度填充、背景模糊和白色高光边缘。

## 修改文件

- `project/frontend/app.css`：玻璃背景、卡片渐变光晕、热门卡片底色和 Shader 叠加。
- `project/frontend/js/agents.js`：全库热门计算、装饰挂载及列表重绘清理。
- `project/frontend/js/shader-card.js`：WebGL Shader、鼠标牵引、卡片倾斜及动画生命周期。
- `project/backend/server.mjs`：公开列表返回累计浏览次数，管理员继续使用完整统计。
- `utils/tests/frontend.test.mjs`：热门计算、过滤与分页、请求竞争、全卡倾斜和热门 Shader 挂载。
- `utils/tests/shader-card.test.mjs`：鼠标、动态设置、WebGL 回退与资源释放。
- `utils/tests/api.test.mjs`：真实浏览次数、权限隐私和列表一致性。

数据库结构、字段名、接口路径和依赖保持现有定义。测试使用临时数据库。

## 可复现验证

在项目根目录运行：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec utils/tests/frontend.test.mjs utils/tests/shader-card.test.mjs
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec utils/tests/api.test.mjs utils/tests/views-unit.test.mjs
```

浏览器打开 `http://127.0.0.1:2001/agents.html`：

1. 查看热门 TOP 1–3 的紫色流体是否持续流动。
2. 在热门卡片内移动鼠标，确认流体向光标靠近；在热门和普通卡片左右、上下移动，确认倾斜方向变化，移开后回正。
3. 搜索“文献阅读”，确认只显示匹配记录，且不会将这条普通记录改为热门；重置恢复完整列表。
4. 点击卡片查看详情、点击“打开智能体”在新标签跳转，确认动画不遮挡交互。
5. 在桌面端开启减少动态设置，检查静止展示。本轮按用户最新要求只验证桌面端。

默认效果不需要额外配置。管理端参数说明与全站保存验证见 `doc/card-effects-settings.md`。

## 验证结果

- 前端测试 56 项通过；最终颜色调整后，Shader 专项 12 项再次通过。
- 本轮累计浏览次数接口与数据库单元测试 41 项通过；后续视觉调整没有修改后端。
- 桌面浏览器确认 9 张案例卡片、3 张热门 Shader，热门和普通卡片均可双向倾斜，移开后回正，详情可打开。
- 查询页确认文字位于 Shader 上层，默认透明度恢复为 1，三张热门卡片使用不同颜色；截图保存为 `utils/verify/shots/shader-glass/desktop.png`。
- 本轮按最新要求未验证手机端。
