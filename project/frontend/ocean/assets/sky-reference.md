# 天空素材

- 工具：内置 imagegen，编辑模式。
- 输入：本目录 `surface.jpg`，之前根据用户参考图去除页面元素的海面素材。
- 输出：`sky-reference.png`，2172 × 724，PNG。
- 内容：仅天空、云层与夕阳；无文字、海水、导航、边框。
- 用途：`/ocean/real/` 天空与海浪环境反射。海浪、水下光束和下潜镜头继续由代码驱动；天空素材本身是静态图片。

## 实际提示词

Use case: precise-object-edit. Asset type: a photoreal sky-only background plate for a real-time 3D ocean website. Input image: edit target, the previously cleaned sunset ocean image. Extract and reconstruct only the SKY from this image. Remove the entire sea, waves, water reflections and any text, logos, buttons, borders or interface elements. Frame ONLY the sky from the original top down to just above the sea horizon, as a very wide landscape image about 3:1 (3072 by 1024 preferred). The bottom edge must be atmospheric sky haze, not water or land. Preserve the recognizable original cloud arrangement, photographic fine cloud texture, natural blue sky, gray-blue cloud undersides, delicate gold-pink rim lighting, and warm sunset glow. Preserve the sun at approximately 73% of the width and 92% of the height of the sky-only frame. Do not replace the original clouds with a different dramatic sky; keep the original calm, delicate sunset. Do not stretch clouds vertically. Seamlessly reconstruct any missing sky around the original composition. Natural photographic exposure with a small warm-white sun, fine scattered cloudlets above and layered cloud banks toward the horizon. No ocean, no water, no ground, no mountains, no text, no watermark, no vector shapes, no painted or CGI appearance. Opaque image, no transparency.
