/**
 * 粒子贴图生成器 — 运行时 canvas 绘制，无外部图片资源。
 *
 * softOrb  : 菱形柔光光斑，用于小尺寸粒子（星域点云 / 人形点云 / 星云）
 * starBurst: 菱形星芒 + 内描边，用于大尺寸发光节点（突触 / 星云核心）
 */
import { CanvasTexture, LinearFilter } from 'three';

function drawDiamond(ctx, inset) {
  ctx.beginPath();
  ctx.moveTo(32, 4 + inset);
  ctx.lineTo(60 - inset, 32);
  ctx.lineTo(32, 60 - inset);
  ctx.lineTo(4 + inset, 32);
  ctx.closePath();
  ctx.fill();
}

export function createSoftSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    g.addColorStop(0.25, 'rgba(255, 255, 255, 0.95)');
    g.addColorStop(0.5, 'rgba(0, 255, 230, 0.6)');
    g.addColorStop(0.8, 'rgba(0, 100, 255, 0.2)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    drawDiamond(ctx, 0);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

export function createStarSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    g.addColorStop(0.3, 'rgba(0, 255, 240, 0.8)');
    g.addColorStop(0.7, 'rgba(0, 150, 255, 0.35)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(32, 6);
    ctx.lineTo(58, 32);
    ctx.lineTo(32, 58);
    ctx.lineTo(6, 32);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(32, 14);
    ctx.lineTo(50, 32);
    ctx.lineTo(32, 50);
    ctx.lineTo(14, 32);
    ctx.closePath();
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}
