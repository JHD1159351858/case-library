/**
 * DOM 覆盖层相位控制器 — 与 WebGL 时间轴同步
 *
 * 四组文案相位（数值逐一对应还原基准）：
 *   P1 Human / Synthesis          : 0 → 0.24 淡出（上移 -600px）
 *   P2 Every Cell Is / Falling Apart : 0.26 → 0.64
 *   P3 Structure / Of Life        : 0.62 → 0.92
 *   P4 Vessel / Of The Mind       : 0.90 → 结尾（保持）
 *
 * 每帧由 scene 的 onTimeline 回调驱动，与参考实现同一机制。
 */

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function createOverlay(root) {
  const phases = {
    p1: root.querySelector('[data-phase="p1"]'),
    p2: root.querySelector('[data-phase="p2"]'),
    p3: root.querySelector('[data-phase="p3"]'),
    p4: root.querySelector('[data-phase="p4"]')
  };

  /**
   * 应用相位样式
   * @param {HTMLElement} el
   * @param {number} opacity
   * @param {number} translateY
   */
  function apply(el, opacity, translateY) {
    if (!el) return;
    el.style.opacity = String(opacity);
    el.style.transform = `translateY(${translateY}px)`;
    el.style.pointerEvents = opacity > 0.1 ? 'auto' : 'none';
  }

  return function update(t) {
    // —— P1: 开场即全显，0.10 起上移淡出 ——
    let p1Opacity = 1;
    let p1Y = 0;
    if (t >= 0.1) {
      const e = clamp01((t - 0.1) / 0.14);
      p1Opacity = Math.max(0, 1 - 1.5 * e);
      p1Y = -(600 * e);
    }
    apply(phases.p1, p1Opacity, p1Y);

    // —— P2 ——
    let p2Opacity = 0;
    let p2Y = 40;
    if (t >= 0.26 && t < 0.52) {
      const e = clamp01((t - 0.26) / 0.18);
      p2Opacity = e;
      p2Y = 40 * (1 - e);
    } else if (t >= 0.52 && t < 0.64) {
      const e = clamp01((t - 0.52) / 0.12);
      p2Opacity = Math.max(0, 1 - 1.5 * e);
      p2Y = -(600 * e);
    }
    apply(phases.p2, p2Opacity, p2Y);

    // —— P3 ——
    let p3Opacity = 0;
    let p3Y = 40;
    if (t >= 0.62 && t < 0.84) {
      const e = clamp01((t - 0.62) / 0.16);
      p3Opacity = e;
      p3Y = 40 * (1 - e);
    } else if (t >= 0.84 && t < 0.92) {
      const e = clamp01((t - 0.84) / 0.08);
      p3Opacity = Math.max(0, 1 - 1.5 * e);
      p3Y = -(600 * e);
    }
    apply(phases.p3, p3Opacity, p3Y);

    // —— P4（结尾保持可见） ——
    let p4Opacity = 0;
    let p4Y = 40;
    if (t >= 0.9) {
      const e = clamp01((t - 0.9) / 0.08);
      p4Opacity = e;
      p4Y = 40 * (1 - e);
    }
    apply(phases.p4, p4Opacity, p4Y);
  };
}
