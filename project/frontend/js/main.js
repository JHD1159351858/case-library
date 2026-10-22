/**
 * 入口模块 — 组装场景与覆盖层
 *
 * 降级策略（恢复的 WebGL 提示逻辑）：
 *   - 浏览器不支持 WebGL：显示 #webgl-fallback，品牌 / 导航 / 文案保持可用
 *   - 场景初始化抛错：捕获后同样显示提示，避免白屏
 *   - 运行中 WebGL 上下文丢失：显示提示，引导用户刷新重试
 */
import { createScene } from './scene.js';
import { createOverlay } from './overlay.js';

const container = document.getElementById('webgl');
const overlayRoot = document.getElementById('overlay');
const fallback = document.getElementById('webgl-fallback');

/** WebGL 能力检测（WebGL2 / WebGL1 / 旧版前缀全覆盖） */
function isWebGLAvailable() {
  try {
    const probe = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (probe.getContext('webgl2') ||
          probe.getContext('webgl') ||
          probe.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

/** 显示降级提示；可重复调用，保持幂等 */
function showFallback(reason) {
  if (fallback) fallback.hidden = false;
  if (reason) console.warn('[hero] WebGL fallback shown:', reason);
}

if (container && overlayRoot) {
  if (!isWebGLAvailable()) {
    showFallback('browser does not support WebGL');
  } else {
    try {
      const updateOverlay = createOverlay(overlayRoot);
      createScene({
        container,
        onTimeline: (progress) => {
          updateOverlay(progress);
        }
      });

      // 运行中上下文丢失（如 GPU 重置）：同步显示提示，由用户刷新恢复
      const canvas = container.querySelector('canvas');
      if (canvas) {
        canvas.addEventListener(
          'webglcontextlost',
          () => {
            showFallback('WebGL context lost');
          },
          { once: true }
        );
      }
    } catch (error) {
      showFallback(error);
    }
  }
}
