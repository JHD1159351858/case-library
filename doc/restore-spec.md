# 还原基准清单 — Human Synthesis Header (The World)

> 来源：https://jiro.build/components/header/human-synthesis-header-the-world
> 真实组件运行时：iframe → https://jiro.build/preview/component/marketing-blocks/header/human-synthesis-header-the-world
> 组件源码定位：`/preview` 页面加载的 chunk `17fhsnwgtcn84.js` + `10l~-hwlpfoid.js`（模块 ID 206652）
> 取证素材：`utils/ref-fetch/`（comp1.js = 组件源码 chunk、functions/ = 提取的辅助函数、preview.html、page1/page2.css）
> 状态：参考页面为客户端渲染，以上源码为已实际运行并验证的结构依据，非推测。

---

## 0. 一句话概括

一个 **Three.js 全屏 WebGL 3D 场景 + 750vh 滚动驱动**的暗黑科幻风 Hero 头部：点云星云随滚动依次变形为「人形点阵 → 人体骨骼（青蓝） → 头骨（紫红） → 头骨特写」，期间四组文案相位依次淡入淡出，鼠标可扰动粒子并带动视差旋转。

**这不是普通 DOM 组件。** 还原的核心是 WebGL 场景的几何参数、后处理管线与滚动时间轴，DOM/CSS 只是外围覆盖层。

---

## 1. 页面架构（三层结构）

```
┌─────────────────────────────────────────────────────┐
│ 外层滚动壳  div  w-screen  h-[750vh]  bg-[#000000]     │  ← 750vh 提供滚动行程
│ select-none                                          │
│  ┌───────────────────────────────────────────────┐  │
│  │ 固定视口  div  fixed top-0 left-0 w-full h-screen │  │  ← 始终满屏
│  │  overflow-hidden                                │  │
│  │  ┌─────────────────────────┐                    │  │
│  │  │ canvas 容器（WebGL 渲染）│                    │  │
│  │  └─────────────────────────┘                    │  │
│  │  ┌─────────────────────────┐                    │  │
│  │  │ 覆盖层 z-10              │                    │  │
│  │  │  flex col justify-between│                    │  │
│  │  │  p-6 / sm:p-12 / md:p-16 │                    │  │
│  │  │  pointer-events-none     │                    │  │
│  │  │  ┌── 顶部行: The World + 右侧导航 ──┐          │  │
│  │  │  └──────────────────────────────┘          │  │
│  │  │  ┌── 绝对定位文案组 ×4（相位切换）──┐        │  │
│  │  │  └──────────────────────────────┘          │  │
│  │  └─────────────────────────┘                    │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- 滚动进度：`tP = scrollY / (document.scrollHeight - innerHeight)`，范围 0→1
- 进度平滑：每帧 `t_ += (tP - t_) * 0.08`（缓动跟手），所有动画基于平滑值 `t_`

---

## 2. DOM 结构与文案（全部实测文本）

### 2.1 顶部行（常驻显示）

| 元素 | 内容 | 样式 |
|---|---|---|
| 左上 Logo 文字 | `The World` | #FFF，Anybody，600，30px/30px，capitalize，tracking-tight |
| 右上导航（竖排右对齐） | `Products` `Features` `Technology` `Support` `Pricing` | 14→18→22px（sm/md），uppercase，400，右对齐，每项尾部 `•` |
| 导航 bullet | `•` | #00ffff，font-bold |
| 导航 hover | — | 文字变 #00ffd1，transition-colors，cursor-pointer，pointer-events-auto |

### 2.2 文案相位组（4 组，初始 opacity:0）

| # | 主标题（\n 换行） | 副文案 | 副文案补充 |
|---|---|---|---|
| P1 | `Human`␊`Synthesis` | Neural nodes reconstruct into a perfect human face geometry, representing the ultimate mathematical synthesis of form and mind. | — |
| P2 | `Every Cell Is`␊`Falling Apart` | （无，单标题，宽 1050px max-w-full） | — |
| P3 | `Structure`␊`Of Life` | The fundamental skeletal lattice aligns under gravity. A resilient structural blueprint emerges to shield the vital essence of life. | — |
| P4 | `Vessel`␊`Of The Mind` | The majestic cranial architecture shields our consciousness and houses our thoughts. Within this secure neural dome, memory and form merge into an intricate cosmic crown of glowing starlight. | 眉标：`The Human Cranial Skeleton`（text-xs，uppercase，tracking-[0.3em]，#c77dff，font-mono，600，mt-4） |

### 2.3 文案排版规格

| 项目 | P1 主标题 | P2/P3/P4 主标题 | 副文案段落 |
|---|---|---|---|
| 字号 | 52 / 96 / 135px（默认/sm/md） | 42 / 72 / 105px | 14 / 16 / 18px |
| 行高 | 50 / 92 / 128px | 44 / 72 / 100px | 22 / 26 / 30px |
| 字重 | 600 | 600 | 300 |
| 颜色 | #FFF | #FFF | rgba(255,255,255,0.8) |
| 字距 | tracking-tight | tracking-tighter | normal |
| 字体 | Anybody, sans-serif | 同左 | 同左 |
| 布局 | 左标题 + 右侧段落（md 起两列 grid，gap-8，段落 md:ml-auto max-w-md） | 左标题（两列同 P1） | — |

**定位（4 组通用）**：`absolute bottom-6 sm:bottom-12 md:bottom-16 left-6 sm:left-12 md:left-16 right-6 sm:right-12`，`mb-4 sm:mb-0`，`transition-opacity duration-150`。
初始态：P1 `opacity:0`（无位移）；P2/P3/P4 `opacity:0 + translateY(40px)`。

> 注：参考源码 P4 容器类名存在笔误 `md:left-16` 出现两次（右侧约束槽位重复），建议实现时按 `md:right-16` 修正并在验收清单记录差异（视觉影响 ≤16px）。

---

## 3. WebGL 场景规格（Three.js）

### 3.1 基础管线

| 项 | 值 |
|---|---|
| 渲染器 | `WebGLRenderer{ antialias:true, powerPreference:'high-performance' }`，pixelRatio = min(dpr, 2) |
| 相机 | `PerspectiveCamera(60, w/h, 0.1, 100)`，`position.z = 24` |
| 场景背景 | `#000000` |
| 后处理 | `EffectComposer`：RenderPass + `UnrealBloomPass(Vector2(w,h), strength=0.55, radius=0.18, threshold=0.35)` |
| 自适应 | `ResizeObserver` → 更新 aspect / setSize / composer.setSize |
| 指针 | 全场景 `mousemove` → NDC（tT）；`mouseleave` 重置为 (-9999,-9999) |

### 3.2 五个粒子系统

| # | 名称 | 粒子数 | 材质 | 配色 | 初始变换 |
|---|---|---|---|---|---|
| 1 | 点云人脸（星域） | 90×90 网格参数化 | PointsMaterial size 0.16，菱形柔光 sprite，AdditiveBlending，opacity 0.9 | #ffffff / #00ffd1 / #00ffff / #00aaff / #00a390 随机分布，关键几何处高亮 | rotation.y=π/4.5, rotation.x=0.15, scale=0.1 |
| 2 | 骨骼粒子 | 12,000 | size 0.09，星形柔光 sprite，opacity 0（滚动出现） | 蓝紫系 `#ff1a40→`（注意：粒子主体色为红系暗色，滚动后切换为青蓝），滚动过渡：暗色→ `#00ffea / #a6ffff` 系 | rotation.y=π/6, rotation.x=0.1, scale=0.1 |
| 3 | 骨骼突触节点 | 280（从骨骼点阵抽） | size 0.42，菱形 sprite，opacity 0 | `#ff1a40` → 高亮 `#ffffff/#ff8093` | （并入骨骼组） |
| 4 | 骨骼连线 | 最近邻 ≤2.1 距离成对 | LineBasicMaterial，opacity 0 | 两端插值 `#00ffff → #0055ff` | （并入骨骼组） |
| 5 | 头骨粒子 | 12,000 | size 0.11，星形 sprite，opacity 0 | 紫红系 `#9d4edd / #c77dff / #e0aaff`，面部区 `#f0ebdd` | rotation.y=-π/6, rotation.x=0.05, scale=0.1 |
| 6 | 头骨突触节点 | 220 | size 0.42，菱形 sprite，opacity 0 | `#9d4edd` → `#ffffff/#ff007f/#ff80df` | （并入头骨组） |
| 7 | 头骨连线 | 最近邻 ≤1.95，每点最多 2 连 | LineBasicMaterial，opacity 0 | `#7b2cbf → #9d4edd` | （并入头骨组） |
| 8 | 环境星云 | 14,000 | size 0.26，菱形 sprite，opacity 0.95 | 青色域 `#00ffc8→#062d30`；红色域 `#ff4d6d→#1a0003`；紫色域 `#e0aaff→#10001a` | 半径 4.9–15 随机壳层；rotation.y 每帧 +0.001 |

**几何关键参数**（复刻时照抄，这些数字决定"像不像"）：
- 点云人脸：`i = 4*(1.05 - 0.12*t²)`；`s = π/2.6*r`；`o = π/2.8*t`；`l = i*sin(s)`；`n = 5*sin(o)`；`h = i*cos(s)*0.72`，含鼻梁隆起 `+= 1.15*e*r`、下巴收束、眼眶挖空（双椭球裁剪 u/c < 0.85）与下颌弧线。
- 骨骼/头骨：通过噪声场 `W(x,y,z)`（正弦扰动 `0.28*sin(13*noise + 4.5*noise2)`）对 SDF 采样点做表面扰动；骨骼为脊椎+四肢抽象体（12,000 采样），头骨为颅腔 SDF（12,000 采样）。
- 骨骼/头骨 SDF 采样成本较高，只在初始化执行一次。

### 3.3 鼠标交互（每帧）

| 系统 | 旋转跟随（lerp 0.06） | 扰动 |
|---|---|---|
| 点云 | rot.y/rot.x ±0.22×NDC | 命中半径 6，推力 `e²*3.2 + 0.35*sin(7.5t+4f)*e`，lerp 0.12 |
| 骨骼 | base π/6 ±0.3×NDC，rot.x base 0.1 | 同上（半径 6） |
| 头骨 | base -π/6 ±0.35×NDC，rot.x base 0.05 | 同上（半径 6） |
| 星云 | 弱旋转 | 命中半径 9，推力 `e²*7.5`，lerp 0.08，逐粒子噪声漂移 |

### 3.4 滚动时间轴（核心！t_ = 平滑滚动进度 0→1）

| 区间 | WebGL 场景 | 文案相位 |
|---|---|---|
| 0 ~ 0.10 | 点云 `scale = 1 + 6.5*(t_/0.2)` 放大逼近；opacity 0.9 保持 | P1 "Human Synthesis" 完全可见 |
| 0.10 ~ 0.24 | 点云 opacity → 0 淡出 | P1 上移 `-600px` 淡出 |
| 0.24 ~ 0.26 | （过渡空窗） | — |
| 0.26 ~ 0.44 | 骨骼组 `scale 0.1→1.75`；突触 opacity 0→0.9；颜色切换 暗红→青蓝 | P2 "Every Cell Is Falling Apart" 淡入上移 |
| 0.44 ~ 0.52 | 骨骼保持 scale 1.75 | P2 保持 |
| 0.52 ~ 0.64 | 骨骼 `scale 1.75→6.25` 冲出画面；opacity→0 | P2 上移淡出 |
| 0.62 ~ 0.78 | 头骨组 `scale 0.1→1.65`；突触 opacity 0→0.95 | P3 "Structure Of Life" 淡入上移 |
| 0.78 ~ 0.84 | 头骨保持 | P3 保持 |
| 0.84 ~ 0.92 | 头骨 `scale 1.65→6.15` 冲出；淡出 | P3 上移淡出 |
| 0.90 ~ 0.98 | 头骨特写 `scale→1.7`、opacity 0.95 | P4 "Vessel Of The Mind" + 眉标 淡入 |
| 全程背景 | 星云颜色：青(0-0.3) → 青白(0.3-0.45) → 青(0.45-0.62) → 红(0.62-0.82) → 红(0.82-0.9) → 紫(0.9-0.98) → 紫 | — |

**文案位移细节**：
- 淡入：`opacity = min(1, (t_-start)/span)`，`translateY = 40*(1-e)`px
- 淡出：`opacity = max(0, 1-1.5*e)`，`translateY = -600*e`px
- 文案显隐时同步切换 `pointer-events`（可见时可选中）

---

## 4. 响应式断点

| 断点 | 宽度 | 变化 |
|---|---|---|
| 默认 | < 640px | p-6（24px）边距；标题 52/42px；导航 14px；bottom-6；两列 grid 变单列（堆叠） |
| sm | ≥ 640px | p-12（48px）；标题 96/72px；导航 18px；bottom-12 |
| md | ≥ 768px | p-16（64px）；标题 135/105px；导航 22px；bottom-16；**两列 grid 生效**（标题左 + 段落右） |

移动端验证尺寸建议：375 / 768 / 1440。

---

## 5. 字体与素材

| 资源 | 说明 | 结论 |
|---|---|---|
| 字体 | 源码 inline 指定 `Anybody, sans-serif`（Google Fonts 开源字体，OFL 协议） | 本地方案加载 Anybody（300/400/600 + 可变轴）；fallback: sans-serif |
| 站点实际加载 | 仅 Instrument Serif + Geist/Inter → 线上实际回退为系统 sans-serif | 记录差异：我们按源码设计意图加载 Anybody，视觉更贴近设计目标 |
| 图片/视频素材 | 组件本体零图片、零视频、零纹理文件（sprite 均为运行时 canvas 生成） | **无版权风险，无需替换方案** |
| 依赖 | three.js（MIT）；原站 dependencies 字段为空（Three.js 为内置打包） | 本地方案：three@0.160+ via CDN/npm，含 examples/jsm 的 EffectComposer / RenderPass / UnrealBloomPass |

---

## 6. 交互状态清单（验收用）

| 交互 | 参考行为 | 实现要求 |
|---|---|---|
| 滚动 | 750vh 行程驱动全部相位 | 必须（用 `scrollY / (scrollHeight - innerHeight)`） |
| 鼠标移动 | 4 组 3D 物体视差旋转 + 粒子推开 | 必须 |
| 鼠标离开 | 旋转回正、扰动复位 | 必须 |
| 导航 hover | 文字 → #00ffd1 | 必须（150ms 过渡） |
| 导航 active/click | 参考页无定义（原型态，无跳转） | 基础保持；如需演示反馈可加轻微按压效果（标注为增强项，默认关闭） |
| 文案选中 | 可见相位文案 pointer-events: auto | 必须 |
| 窗口缩放 | 场景自适应不拉伸 | 必须（ResizeObserver） |

---

## 7. 工程实现建议（待用户确认技术栈后生效）

- **推荐**：原生 HTML + CSS + ES Module JS（importmap 引 three），零构建、零框架，最贴近"保存即用 + 独立运行"；目录 `project/frontend/`（index.html / styles.css / main.js [可拆 scene.js / particles.js / timeline.js / overlay.js]）
- **备选**：React + Vite（对齐原站技术生态，引入构建链，收益低）
- **建议端口**：前端 1001（HTTP 静态服务，如 `python -m http.server 1001` 或 Vite dev），后端 2001（占位约定，本组件纯前端无后端依赖）
- **端口冲突检查**：`D:\Crow5\Project` 下现有 `case1-agent-frontend` 使用 5173/8787 → **1001/2001 无冲突**
- 注意：`file://` 直接打开会因 ES Module CORS 限制无法运行，需本地 HTTP 服务（属正常约束）

---

## 8. 独立实现与参考构建产物的边界（合规说明）

- `utils/ref-fetch/` 中的 chunk/CSS 仅作为**行为取证与验收对照**使用，不得直接拷贝进交付代码。
- 交付代码为基于上述参数（几何公式、时间轴、配色）的**独立重写**，Three.js 与字体均为 MIT/OFL 开源许可。
