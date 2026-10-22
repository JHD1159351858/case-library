# 验收清单：Human Synthesis Header 还原项目

> 项目路径：D:\Crow5\Project\agent-official-website
> 还原对象：jiro.build「Human Synthesis Header - The World」
> 还原基准：doc/restore-spec.md
> 前端技术：原生 HTML/CSS/ES Modules JS + 本地 three.js（无构建、纯静态）
> 编制：Emilia　|　日期：2026-09-12　|　版本：v1.0

## 一、交付物清单

| 序号 | 交付物 | 路径 | 说明 |
|:---:|---|---|---|
| 1 | 前端代码 | `project/frontend/` | 原生 HTML/CSS/ES Modules JS + 本地 three.js；无构建、纯静态 |
| 2 | 项目说明 | `README.md` | 项目说明（含端口分配与启动方式） |
| 3 | 验证脚本 | `utils/verify/cdp-verify.mjs` | CDP 无头 Chrome 自动验证：截图 + 像素统计 + 控制台检查 |
| 4 | 截图证据 | `utils/verify/shots/` | 根目录 9 张最新截图；`v2-20260912-200757/` 为完整产物（含 report.json） |
| 5 | 本清单 | `doc/acceptance-checklist.md` | 验收标准、验证步骤、已知观察项与验收结论 |

核心结构：750vh 滚动壳 + fixed 全屏 WebGL 渲染层 + DOM 覆盖层；四组相位文案（P1 Human Synthesis / P2 Every Cell Is Falling Apart / P3 Structure Of Life / P4 Vessel Of The Mind，眉标 The Human Cranial Skeleton）；五系统（人脸星域、人形点阵、骨架、头骨、外层星云）+ UnrealBloom 泛光 + 鼠标斥力 / 视差交互。

## 二、对照参考的验收清单

| 分项 | 验收标准 | 状态 |
|---|---|---|
| 布局结构 | 750vh 滚动壳 + fixed 全屏 WebGL 渲染层 + DOM 覆盖层结构正确；四组相位文案随滚动进度出现，层不错位 | 已通过（9 张截图 + 自动脚本 pass: true） |
| 配色 | 关键交互色与主视觉配色对照参考一致 | 已通过（导航 hover 实测 rgb(0,255,209)=#00ffd1；全量色板对照建议人工终检） |
| 字体层级 | 标题 / 眉标 / 正文的层级（字号、字重、字距）与参考一致 | 待人工复核（自动化未覆盖） |
| 间距 | 文案与元素的内边距、区块间距与参考对照一致 | 待人工复核（自动化未覆盖） |
| 圆角与阴影 | 覆盖层 UI 的圆角、阴影与参考一致 | 待人工复核（自动化未覆盖） |
| 动效与过渡 | 滚动相位切换、鼠标视差动效生效；过渡自然无跳变 | 已通过（相位切换、视差方向 / 对称性 / 可逆性已验证；缓动曲线建议人工对照） |
| 交互状态（hover / active / click） | hover 有明确响应；active / click 无异常反馈 | hover 已通过（实测 #00ffd1）；active / click 待人工复核 |
| 响应式（PC / 平板 / 手机） | 自适应兼容 PC / 768 / 375；布局与渲染正常 | 已通过（视口自适应验证 + tablet-768-figure、mobile-375-bone 截图） |
| 性能 | 无控制台报错；滚动与渲染流畅、无明显卡顿 | 待人工复核（pass: true、控制台 0 报错为最低门槛；真机 FPS / GPU 占用未实测） |

附：已完成的对齐修正（对照参考）

1. 人形突触基础色 `#ffffff`、采样上限 15000 —— 已对齐参考。
2. skullSDF 侧臂球参数 `(±1.8, 0.05, 0.7)`、半径 0.75 —— 已对齐参考公式。

## 三、逐项验证步骤

### ① 启动服务

1）进入前端目录：

```
cd D:\Crow5\Project\agent-official-website\project\frontend
```

2）启动静态服务：

```
python -m http.server 1002 --bind 127.0.0.1
```

3）浏览器访问：http://127.0.0.1:1002

端口说明：前端 1002（1001 被系统进程 PID 4 占用，已规避）；后端无（2001 预留）；无数据库。

### ② 自动验证（CDP 无头 Chrome）

在项目根目录执行：

```
node utils/verify/cdp-verify.mjs http://127.0.0.1:1002/ <输出目录>
```

产物：截图 + 像素统计 + 控制台检查（report.json）。

最新基线（本轮验证结果，可直接对照）：

- pass: true；控制台 0 报错
- nonBlack = 114155 / 317520
- 截图位于 `utils/verify/shots/` 根目录：pc-00-start、pc-15-face-zoom、pc-35-figure、pc-70-bone、pc-88-skull、pc-995-skull-close、pc-nav-hover、tablet-768-figure、mobile-375-bone
- 新脚本完整产物示例：`utils/verify/shots/v2-20260912-200757/`（含 report.json）

### ③ 手动验证

（1）六个滚动相位对照：

| 滚动进度 | 对照截图 | 确认要点 |
|:---:|---|---|
| 0 | pc-00-start | 起始画面正常渲染 |
| 0.15 | pc-15-face-zoom | 人脸近景相位 |
| 0.35 | pc-35-figure | 人形点阵相位 |
| 0.70 | pc-70-bone | 骨架相位 |
| 0.88 | pc-88-skull | 头骨相位 |
| 0.995 | pc-995-skull-close | 头骨近景（末段） |

滚动全程核对四组相位文案：P1 Human Synthesis → P2 Every Cell Is Falling Apart → P3 Structure Of Life → P4 Vessel Of The Mind，眉标 The Human Cranial Skeleton。

（2）导航 hover：悬停导航项，颜色应变为 rgb(0,255,209)（#00ffd1，已实测）。

（3）响应式（375 / 768）：将视口宽度切至 375（手机）与 768（平板），检查布局与渲染；对照 mobile-375-bone、tablet-768-figure；PC 宽度对照 pc-* 系列。

（4）鼠标扰动 / 视差：移动鼠标，粒子应受斥力偏移、画面产生视差；方向正确、左右对称、移开后回归原位（可逆）。

（5）相位层交互：滚动跨相位时 DOM 覆盖层 pointer-events 切换正常（已验证）。

## 四、已知观察项（非阻塞）

| 序号 | 观察项 | 阻塞性 | 说明 |
|:---:|---|---|---|
| 1 | 软渲染环境下未点亮粒子观感偏灰白 | 非阻塞 | 经核查 sprites.js 与参考逐字一致，非代码差异；待真机（硬件 GPU）环境对照评估 |
| 2 | 近景较大菱形光斑 | 非阻塞 | 源自参考的「粒子大小随距离衰减」设计，属还原行为；建议真机与参考并排确认观感 |

## 五、验收结论

**通过项**

- 自动验证 pass: true，控制台 0 报错
- 渲染输出正常（nonBlack = 114155 / 317520）
- 6 个滚动相位 + 导航 hover + 375 / 768 响应式均有截图证据
- 关键交互实测通过：导航 hover #00ffd1、相位 pointer-events 切换、视差方向 / 对称性 / 可逆性
- 对照参考的对齐修正已完成（人形突触基础色 / 采样上限 / skullSDF 侧臂球参数）

**观察项**

- 第四节所列 2 项，均为非阻塞，待真机对照确认。

**遗留风险**

- 软渲染环境的灰白观感与菱形光斑需在真机（硬件 GPU）与参考并排对照后最终确认
- 性能（真机 FPS / GPU 占用）未实测，自动脚本仅覆盖「pass + 0 控制台报错」
- 字体层级、间距、圆角与阴影等视觉细节需与参考逐项人工对照（自动化未覆盖）
- active / click 交互状态未单独验证

**总体结论：自动化验证范围内全部通过；待完成真机人工终检后放行。**
