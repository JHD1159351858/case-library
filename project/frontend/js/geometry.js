/**
 * 几何生成模块 — 还原基准的全部形状参数来源：doc/restore-spec.md
 *
 * 五个视觉系统的点阵生成：
 *   1. buildFaceStarfield  — 90×90 参数化"人脸星域"（开场 0-24% 滚动）
 *   2. buildSynthesisFigure — 人形点阵（15k + 4k + 2k）"Every Cell Is Falling Apart"
 *   3. buildBoneSystem      — SDF 骨架（脊椎 + 髓关节）"Structure Of Life"
 *   4. buildSkullSystem     — SDF 头骨（颅腔 + 颚 + 齿）"Vessel Of The Mind"
 *   5. buildNebula          — 14k 星云壳层（随滚动变色 青→红→紫）
 *
 * 突触（synapses）与连线（connections）由三个共享构建器生成，
 * 支撑每帧的鼠标扰动联动（连线端点跟随突触实时位移）。
 */
import { Color } from 'three';

// ---------------------------------------------------------------------------
// 平滑布尔（SDF 造型）
// ---------------------------------------------------------------------------

/** 平滑相交（smooth intersection） */
function smoothIntersect(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * h * k * (1 / 6);
}

/** 平滑并集（smooth union） */
function smoothUnion(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * h * k * (1 / 6);
}

// ---------------------------------------------------------------------------
// 1. 人脸星域（开场点云）
// ---------------------------------------------------------------------------

/**
 * 90×90 参数化网格人脸：含鼻梁隆起、眼眶与嘴部挖空、下巴收窄。
 * 配色：眼周白 / 鼻梁青 / 边缘墨青 / 其余青蓝随机。
 */
export function buildFaceStarfield() {
  const positions = [];
  const colors = [];
  const N = 90;
  for (let ti = 0; ti < N; ti++) {
    const t = (ti / (N - 1)) * 2 - 1;
    for (let ri = 0; ri < N; ri++) {
      const r = (ri / (N - 1)) * 2 - 1;
      const s = (Math.PI / 2.6) * r;
      const o = (Math.PI / 2.8) * t;
      const i = 4 * (1.05 - 0.12 * t * t);
      let l = i * Math.sin(s);
      let n = 5 * Math.sin(o);
      let h = i * Math.cos(s) * 0.72;

      if (t < -0.2) l *= 1 - 0.45 * Math.abs(t + 0.2);

      const f = Math.abs(s);
      let nose = false;
      if (f < 0.26 && t > -0.25 && t < 0.45) {
        const e = 1 - f / 0.26;
        const rr = Math.cos(((t - 0.1) / 0.35) * (Math.PI / 2));
        if (rr > 0) {
          h += 1.15 * e * rr; // 鼻梁隆起
          nose = true;
        }
      }
      if (t > 0.5) h -= 0.45 * Math.pow((t - 0.5) / 0.5, 2); // 顶部收束

      // 眼眶（双椭球）与嘴部（扁椭球）挖空
      const eyeL = Math.sqrt(Math.pow((r - -0.42) / 0.22, 2) + Math.pow((t - 0.22) / 0.14, 2));
      const eyeR = Math.sqrt(Math.pow((r - 0.42) / 0.22, 2) + Math.pow((t - 0.22) / 0.14, 2));
      if (eyeL < 0.85 || eyeR < 0.85) continue;
      if (Math.sqrt(Math.pow(r / 0.34, 2) + Math.pow((t - -0.42) / 0.06, 2)) < 0.7) continue;

      // 嘴部波纹
      if (t > -0.55 && t < -0.3 && f < 0.4) {
        h += (1 - f / 0.4) * 0.25 * Math.sin((t + 0.42) * 10);
      }

      l += (Math.random() - 0.5) * 0.015;
      n += (Math.random() - 0.5) * 0.015;
      h += (Math.random() - 0.5) * 0.015;
      positions.push(l, n, h);

      const color = new Color();
      const eyeRing = Math.abs(eyeR - 1);
      if (Math.abs(eyeL - 1) < 0.18 || eyeRing < 0.18) color.set('#ffffff');
      else if (nose) color.set('#00ffff');
      else if (Math.abs(r) > 0.85 || Math.abs(t) > 0.85) color.set('#00a390');
      else {
        const pick = Math.random();
        if (pick < 0.35) color.set('#00ffd1');
        else if (pick < 0.7) color.set('#00ffff');
        else color.set('#00aaff');
      }
      colors.push(color.r, color.g, color.b);
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    pointCount: positions.length / 3
  };
}

// ---------------------------------------------------------------------------
// 2. 人形点阵（Every Cell Is Falling Apart）
// ---------------------------------------------------------------------------

/**
 * 人形轮廓变形：截面收放、正面胸部/面部隆起、腰腹与腿部塑形。
 * 输入基形为椭球壳层采样点，输出压成人形轮廓。
 */
function deformHumanFigure(x, y, z) {
  let a = 0.95 * x;
  let s = 0.95 * z;
  const o = y / 3;
  a *= o < 0 ? 1 + 0.42 * o : 1 - o * o * 0.12; // 下宽上窄
  if (z > 0) {
    const e = Math.abs(a);
    if (e < 0.65 && y > -0.4 && y < 0.8) {
      const r = Math.cos((e / 0.65) * (Math.PI / 2));
      const a2 = Math.cos(((y - 0.2) / 0.6) * (Math.PI / 2));
      if (a2 > 0) s += 1.85 * r * a2; // 正面大隆起
    }
    const r2 = Math.sqrt(Math.pow(a + 0.85, 2) + 1.5 * Math.pow(y - 0.9, 2));
    const o2 = Math.sqrt(Math.pow(a - 0.85, 2) + 1.5 * Math.pow(y - 0.9, 2));
    if (r2 < 0.7) s -= 0.55 * Math.cos((r2 / 0.7) * (Math.PI / 2));
    if (o2 < 0.7) s -= 0.55 * Math.cos((o2 / 0.7) * (Math.PI / 2));
    const i3 = Math.sqrt(a * a + 3.5 * Math.pow(y + 0.5, 2));
    if (i3 < 0.72) s += Math.cos((i3 / 0.72) * (Math.PI / 2)) * Math.sin(((y + 0.5) / 0.36) * Math.PI) * 0.45;
    const l3 = Math.sqrt(a * a + 2.5 * Math.pow(y + 1.5, 2));
    if (l3 < 0.65) s += 0.65 * Math.cos((l3 / 0.65) * (Math.PI / 2));
    const n3 = Math.sqrt(Math.pow(a + 1.25, 2) + 2 * Math.pow(y + 0.1, 2));
    const h3 = Math.sqrt(Math.pow(a - 1.25, 2) + 2 * Math.pow(y + 0.1, 2));
    if (n3 < 0.9) s += 0.35 * Math.cos((n3 / 0.9) * (Math.PI / 2));
    if (h3 < 0.9) s += 0.35 * Math.cos((h3 / 0.9) * (Math.PI / 2));
  }
  return { x: a, y, z: s };
}

/**
 * 人形点阵 = 躯干（15k 斐波那契椭球 + 噪声浮点） + 内脏/头部（4k） + 底座腿锥（2k）。
 * 返回点阵、两套配色（原色 / 高亮色）与原始位置快照（鼠标扰动基准）。
 */
export function buildSynthesisFigure(noise) {
  const positions = [];
  const colorsBase = [];
  const colorsBright = [];

  // —— 躯干 15k ——
  for (let i = 0; i < 15000; i++) {
    const theta = Math.acos(1 - (i / 15000) * 2);
    const phi = Math.PI * (1 + Math.sqrt(5)) * i;
    let sx = Math.sin(theta) * Math.cos(phi) * 3.3;
    let sy = 2.4 * Math.cos(theta) + 0.35;
    let sz = Math.sin(theta) * Math.sin(phi) * 3.8;

    if (sz > 0) {
      sx *= 1 - (sz / 3.8) * 0.14;
      sy *= 1 - (sz / 3.8) * 0.08;
    }
    if (sz < -0.3 && sy < 0.4) sy += 0.95 * Math.min(1, -((sz + 0.3) / 2.5));
    if (Math.abs(sx) > 0.8 && sy > -0.6 && sy < 0.8 && sz > -0.8 && sz < 1.4) {
      const e = 0.12 * Math.exp(-2 * Math.pow(sy - 0.1, 2));
      sx -= (sx > 0 ? 1 : -1) * e; // 腰部收窄
    }

    const shrink = 1 - 0.28 * Math.exp(-6 * sx * sx);
    sx *= shrink;
    const shaped = deformHumanFigure(sx, sy, sz);
    sx = shaped.x;
    sy = shaped.y;
    sz = shaped.z;

    const ripple = 0.28 * Math.sin(13 * noise(0.55 * sx, 0.55 * sy, 0.55 * sz) + 4.5 * noise(1.5 * sx, 1.5 * sy, 1.5 * sz));
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    sx += (sx / len) * ripple + (Math.random() - 0.5) * 0.02;
    sy += (sy / len) * ripple + (Math.random() - 0.5) * 0.02;
    sz += (sz / len) * ripple + (Math.random() - 0.5) * 0.02;
    positions.push(sx, sy, sz);

    const base = new Color();
    const bright = new Color();
    const g = Math.random();
    if (ripple > 0.08) {
      base.set(Math.random() < 0.6 ? '#00ffea' : '#a6ffff');
      bright.set(g < 0.7 ? '#ffffff' : '#eaffff');
    } else if (ripple > -0.05) {
      base.set(Math.random() < 0.5 ? '#00a2ff' : '#00ffff');
      bright.set(g < 0.5 ? '#b6f7ff' : '#6bfcff');
    } else {
      base.set(Math.random() < 0.6 ? '#0051ff' : '#0026b3');
      if (g < 0.5) bright.set('#0088ff');
      else if (g < 0.8) bright.set('#e8ccff');
      else bright.set('#1a3dfc');
    }
    colorsBase.push(base.r, base.g, base.b);
    colorsBright.push(bright.r, bright.g, bright.b);
  }

  // —— 内脏/头部 4k ——
  for (let i = 0; i < 4000; i++) {
    const theta = Math.acos(1 - (i / 4000) * 2);
    const phi = Math.PI * (1 + Math.sqrt(5)) * i;
    let sx = Math.sin(theta) * Math.cos(phi) * 1.85;
    let sy = 0.95 * Math.cos(theta) - 0.7;
    let sz = Math.sin(theta) * Math.sin(phi) * 1.45 - 1.4;
    const shaped = deformHumanFigure(sx, sy, sz);
    sx = shaped.x;
    sy = shaped.y;
    sz = shaped.z;

    const n = noise(1.5 * sx, 3.5 * sy, 1.5 * sz);
    const ripple = 0.08 * Math.sin(45 * sy + 1.8 * n);
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    sx += (sx / len) * ripple + (Math.random() - 0.5) * 0.02;
    sy += (sy / len) * ripple + (Math.random() - 0.5) * 0.02;
    sz += (sz / len) * ripple + (Math.random() - 0.5) * 0.02;
    positions.push(sx, sy, sz);

    const base = new Color();
    const bright = new Color();
    const c = Math.random();
    if (ripple > 0.02) {
      base.set('#00ffda');
      bright.set(c < 0.6 ? '#ffffff' : '#a1fff1');
    } else {
      base.set('#0062ff');
      bright.set(c < 0.5 ? '#00a2ff' : '#bbfdff');
    }
    colorsBase.push(base.r, base.g, base.b);
    colorsBright.push(bright.r, bright.g, bright.b);
  }

  // —— 底座腿锥 2k（六边形量化） ——
  for (let i = 0; i < 2000; i++) {
    const t = i / 2000;
    const y = -0.9 - 2.2 * t;
    const s = Math.random() * Math.PI * 2;
    const snapped = (Math.PI * 2 / 6) * Math.round(s / (Math.PI * 2 / 6));
    const ang = s + (snapped - s) * 0.85;
    const rad = 0.45 * (1 - 0.95 * t) + 0.04 * Math.sin(6 * s);
    const x = rad * Math.cos(ang);
    const z = rad * Math.sin(ang) - 0.15 * t;
    positions.push(x, y, z);

    const base = new Color();
    const bright = new Color();
    const u = Math.random();
    if (u < 0.4) base.set('#00aeff');
    else if (u < 0.8) base.set('#0055ff');
    else base.set('#00ffea');
    const c = Math.random();
    if (c < 0.4) bright.set('#ffffff');
    else if (c < 0.8) bright.set('#9ef4ff');
    else bright.set('#e1ccff');
    colorsBase.push(base.r, base.g, base.b);
    colorsBright.push(bright.r, bright.g, bright.b);
  }

  return {
    positions: new Float32Array(positions),
    colorsBase: new Float32Array(colorsBase),
    colorsBright: new Float32Array(colorsBright),
    totalPoints: positions.length / 3
  };
}

// ---------------------------------------------------------------------------
// 3. 骨架系统（Structure Of Life）
// ---------------------------------------------------------------------------

/** 骨架 SDF：中轴脊椎（半径沿 Y 变化）+ 顶/髋四个髓关节球的平滑相交 */
function boneSDF(x, y, z) {
  const s = Math.max(0, Math.min(1, (y + 3.8) / 7.6));
  const wrappedY = y - (-3.8 + 7.6 * s);
  const spine = Math.sqrt(x * x + wrappedY * wrappedY + z * z);
  const absY = Math.abs(y);
  let w = spine - (0.48 + 0.12 * Math.pow(absY / 3.8, 2) + 0.3 * Math.pow(absY / 3.8, 6));

  const joints = [
    [x + 0.6, y - 3.7],
    [x - 0.6, y - 3.7],
    [x + 0.6, y + 3.7],
    [x - 0.6, y + 3.7]
  ];
  for (const [jx, jy] of joints) {
    const d = Math.sqrt(jx * jx + jy * jy + z * z) - 0.78;
    w = smoothIntersect(w, d, 0.65);
  }
  return w;
}

/** 数值梯度并将点投影到"表面 ± 噪声壳层" */
function projectBonePoint(x, y, z, noiseValue) {
  const field = boneSDF(x, y, z);
  const dx = (boneSDF(x + 0.005, y, z) - boneSDF(x - 0.005, y, z)) / 0.01;
  const dy = (boneSDF(x, y + 0.005, z) - boneSDF(x, y - 0.005, z)) / 0.01;
  const dz = (boneSDF(x, y, z + 0.005) - boneSDF(x, y, z - 0.005)) / 0.01;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (len > 1e-4) {
    nx = dx / len;
    ny = dy / len;
    nz = dz / len;
  }
  const g = field - (-0.12 + 0.18 * noiseValue);
  return { x: x - nx * g, y: y - ny * g, z: z - nz * g };
}

/**
 * 骨架点阵 12,000：50% 脊椎柱 + 25% 头球 + 25% 髋球，全部投影到噪声表面。
 * 配色：玫瑰红渐变（原色） / 红白高亮（琥珀）。
 */
export function buildBoneSystem(noise) {
  const positions = [];
  const colorsBase = [];
  const colorsBright = [];

  for (let i = 0; i < 12000; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    const s = Math.random();
    if (s < 0.5) {
      const theta = Math.random() * Math.PI * 2;
      y = -3.4 + 6.8 * Math.random();
      const rr = 0.48 + 0.12 * Math.pow(Math.abs(y) / 3.8, 2);
      x = rr * Math.cos(theta);
      z = rr * Math.sin(theta);
    } else {
      const theta = Math.acos(1 - 2 * Math.random());
      const phi = Math.random() * Math.PI * 2;
      const sideX = Math.random() < 0.5 ? -0.6 : 0.6;
      const baseY = s < 0.75 ? 3.7 : -3.7;
      x = sideX + 0.78 * Math.sin(theta) * Math.cos(phi);
      y = baseY + 0.78 * Math.cos(theta);
      z = 0.78 * Math.sin(theta) * Math.sin(phi);
    }
    const projected = projectBonePoint(x, y, z, noise(x, y, z));
    positions.push(projected.x, projected.y, projected.z);

    const base = new Color();
    const bright = new Color();
    const o = Math.random();
    if (o < 0.4) base.set('#ff1a40');
    else if (o < 0.8) base.set('#ff002c');
    else base.set('#ff4d6d');
    const c = Math.random();
    if (c < 0.5) bright.set('#ff0022');
    else if (c < 0.8) bright.set('#ff3355');
    else bright.set('#ffffff');
    colorsBase.push(base.r, base.g, base.b);
    colorsBright.push(bright.r, bright.g, bright.b);
  }

  return {
    positions: new Float32Array(positions),
    colorsBase: new Float32Array(colorsBase),
    colorsBright: new Float32Array(colorsBright),
    totalPoints: positions.length / 3
  };
}

// ---------------------------------------------------------------------------
// 4. 头骨系统（Vessel Of The Mind）
// ---------------------------------------------------------------------------

/** 头骨 SDF：颅腔椭球 ∥ 下颌椭球 ∥ 腮部球 ∥ 双臂球；随后挖去眼窝、颞部与鼻腔 */
function skullSDF(x, y, z) {
  const domeA = 1.15 * x;
  const domeS = y - 1.25;
  const domeO = 0.95 * z;
  const jawN = 1.35 * x;
  const jawH = y + 0.15;
  const jawF = z - 0.95;
  const cheekD = (1.4 * x) / (1 - Math.max(0, (-y - 0.8) * 0.18));
  const cheekU = y + 1.85;
  const cheekC = z - 0.65;

  let C = smoothIntersect(
    Math.sqrt(domeA * domeA + domeS * domeS + domeO * domeO) - 3.25,
    Math.sqrt(jawN * jawN + jawH * jawH + jawF * jawF) - 1.95,
    0.8
  );
  C = smoothIntersect(C, Math.sqrt(cheekD * cheekD + cheekU * cheekU + cheekC * cheekC) - 1.6, 0.85);

  const sideA = Math.sqrt(Math.pow(x + 1.8, 2) + Math.pow(y - 0.05, 2) + Math.pow(z - 0.7, 2)) - 0.75;
  const sideB = Math.sqrt(Math.pow(x - 1.8, 2) + Math.pow(y - 0.05, 2) + Math.pow(z - 0.7, 2)) - 0.75;
  C = smoothIntersect(C, sideA, 0.55);
  C = smoothIntersect(C, sideB, 0.55);

  // 挖去：双颞窝 + 鼻腔
  const cavityA = Math.sqrt(1.1 * Math.pow(x + 1.1, 2) + 1.35 * Math.pow(y - 0.55, 2) + Math.pow(z - 1.8, 2)) - 0.85;
  const cavityB = Math.sqrt(1.1 * Math.pow(x - 1.1, 2) + 1.35 * Math.pow(y - 0.55, 2) + Math.pow(z - 1.8, 2)) - 0.85;
  const nasal = Math.sqrt(2.1 * x * x + 1.25 * Math.pow(y + 0.35, 2) + Math.pow(z - 1.9, 2)) - 0.55;
  C = smoothUnion(C, -cavityA, 0.25);
  C = smoothUnion(C, -cavityB, 0.25);
  C = smoothUnion(C, -nasal, 0.18);

  // 牙齿排线
  if (z > 1 && y > -1.75 && y < -0.9) {
    const d = Math.abs(z - (1.7 - x * x * 0.45));
    if (d < 0.45 && Math.abs(x) < 1.35) {
      C += -Math.max(0, 0.15 - d) * (Math.abs(0.12 * Math.sin(14 * Math.atan2(x, z - 0.3))) + 1.8 * Math.max(0, 0.08 - (Math.abs(y + 1.35) - 0.05)));
    }
  }
  return C;
}

/** 投影到表面：4 步梯度下降（步长 0.85），目标壳厚 -0.12 + 0.16×噪声 */
function projectSkullPoint(x, y, z, seed) {
  let px = x;
  let py = y;
  let pz = z;
  const target = -0.12 + 0.16 * seed;
  for (let i = 0; i < 4; i++) {
    const f = skullSDF(px, py, pz);
    const dx = (skullSDF(px + 0.005, py, pz) - skullSDF(px - 0.005, py, pz)) / 0.01;
    const dy = (skullSDF(px, py + 0.005, pz) - skullSDF(px, py - 0.005, pz)) / 0.01;
    const dz = (skullSDF(px, py, pz + 0.005) - skullSDF(px, py, pz - 0.005)) / 0.01;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) break;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    const move = (f - target) * 0.85;
    px -= nx * move;
    py -= ny * move;
    pz -= nz * move;
  }
  return { x: px, y: py, z: pz };
}

/**
 * 头骨点阵 12,000：立方体拒绝采样 + SDF 投影。
 * 配色：紫罗兰渐变（原色），下颌/牙齿区骨白 #f0ebdd。
 */
export function buildSkullSystem(noise) {
  const positions = [];
  const colorsBase = [];
  const colorsBright = [];
  let count = 0;

  while (count < 12000) {
    const x = (Math.random() - 0.5) * 7.5;
    const y = -3.2 + 7.4 * Math.random();
    const z = (Math.random() - 0.5) * 6.5;

    const eyeL = Math.sqrt(Math.pow(x + 1.05, 2) + 1.3 * Math.pow(y - 0.6, 2) + Math.pow(z - 1.8, 2));
    const eyeR = Math.sqrt(Math.pow(x - 1.05, 2) + 1.3 * Math.pow(y - 0.6, 2) + Math.pow(z - 1.8, 2));
    const nasal = Math.sqrt(1.8 * x * x + 1.1 * Math.pow(y + 0.35, 2) + Math.pow(z - 1.9, 2));
    if (eyeL < 0.82 || eyeR < 0.82 || nasal < 0.52) continue;
    if (z > 1.2 && y > -1.7 && y < -1.4 && Math.abs(x) < 1.3 && Math.random() < 0.6) continue;

    const seed = noise(x, y, z);
    const field = skullSDF(x, y, z);
    if (field > 0.85) continue;

    const projected = projectSkullPoint(x, y, z, seed);
    const cheekL = Math.sqrt(Math.pow(projected.x + 1.05, 2) + 1.3 * Math.pow(projected.y - 0.6, 2) + Math.pow(projected.z - 1.8, 2));
    const cheekR = Math.sqrt(Math.pow(projected.x - 1.05, 2) + 1.3 * Math.pow(projected.y - 0.6, 2) + Math.pow(projected.z - 1.8, 2));
    const noseGap = Math.sqrt(1.8 * projected.x * projected.x + 1.1 * Math.pow(projected.y + 0.35, 2) + Math.pow(projected.z - 1.9, 2));
    if (cheekL < 0.55 || cheekR < 0.55 || noseGap < 0.35) continue;

    positions.push(projected.x, projected.y, projected.z);
    count++;

    const base = new Color();
    const bright = new Color();
    const jaw = projected.z > 1.25 && projected.y > -1.75 && projected.y < -0.95 && Math.abs(projected.x) < 1.35;
    if (jaw) {
      base.set('#f0ebdd');
      bright.set('#ffffff');
    } else {
      const e = Math.random();
      if (e < 0.45) base.set('#9d4edd');
      else if (e < 0.8) base.set('#c77dff');
      else base.set('#e0aaff');
      const t = Math.random();
      if (t < 0.5) bright.set('#ff00a0');
      else if (t < 0.85) bright.set('#ff5c8a');
      else bright.set('#ffffff');
    }
    colorsBase.push(base.r, base.g, base.b);
    colorsBright.push(bright.r, bright.g, bright.b);
  }

  return {
    positions: new Float32Array(positions),
    colorsBase: new Float32Array(colorsBase),
    colorsBright: new Float32Array(colorsBright),
    totalPoints: count
  };
}

// ---------------------------------------------------------------------------
// 5. 星云壳层
// ---------------------------------------------------------------------------

/**
 * 14k 星云点：55% 高斯壳（半径约 8.25±）+ 45% 幂律内层，最小半径 4.9。
 * 四套色板（基础青 / 青白 / 红 / 紫）供滚动时间轴插值。
 */
export function buildNebula() {
  const count = 14000;
  const positions = new Float32Array(count * 3);
  const colorsBase = new Float32Array(count * 3);
  const colorsCyan = new Float32Array(count * 3);
  const colorsRed = new Float32Array(count * 3);
  const colorsViolet = new Float32Array(count * 3);

  const cyanA = new Color('#00ffc8');
  const cyanB = new Color('#062d30');

  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    let s;
    if (Math.random() < 0.55) {
      const gauss = Math.sqrt(-2 * Math.log(Math.random() || 1e-4)) * Math.sin(2 * Math.PI * Math.random());
      s = 15 * (0.55 + gauss * 0.08);
    } else {
      s = 4.9 + 10.1 * Math.pow(Math.random(), 1.5);
    }
    s = Math.max(s, 4.9);
    const x = s * Math.sin(phi) * Math.cos(theta);
    const y = s * Math.sin(phi) * Math.sin(theta);
    const z = s * Math.cos(phi);
    positions[3 * i] = x;
    positions[3 * i + 1] = y;
    positions[3 * i + 2] = z;

    // 基础青（按半径向深青插值）
    const n2 = Math.min(s / 15, 1);
    const color = new Color();
    if (n2 < 0.45) {
      const e = n2 / 0.45;
      color.lerpColors(cyanA, cyanA.clone().lerp(cyanB, 0.45), e);
    } else {
      const e = (n2 - 0.45) / 0.55;
      color.lerpColors(cyanA.clone().lerp(cyanB, 0.45), cyanB, e);
    }
    color.r += (Math.random() - 0.5) * 0.03;
    color.g += (Math.random() - 0.5) * 0.03;
    color.b += (Math.random() - 0.5) * 0.03;
    colorsBase[3 * i] = Math.max(0, Math.min(1, color.r));
    colorsBase[3 * i + 1] = Math.max(0, Math.min(1, color.g));
    colorsBase[3 * i + 2] = Math.max(0, Math.min(1, color.b));

    // 青白域
    const c = new Color();
    const cp = Math.random();
    if (cp < 0.1) c.set('#ffffff');
    else if (cp < 0.4) c.set('#c9faff');
    else if (cp < 0.7) c.set('#00ffd5');
    else if (cp < 0.85) c.set('#e8ccff');
    else c.set('#031d24');
    colorsCyan[3 * i] = c.r;
    colorsCyan[3 * i + 1] = c.g;
    colorsCyan[3 * i + 2] = c.b;

    // 红域
    const rd = new Color();
    const rp = Math.random();
    if (rp < 0.1) rd.set('#ffffff');
    else if (rp < 0.4) rd.set('#ff4d6d');
    else if (rp < 0.7) rd.set('#ff003c');
    else if (rp < 0.85) rd.set('#cc0000');
    else rd.set('#1a0003');
    colorsRed[3 * i] = rd.r;
    colorsRed[3 * i + 1] = rd.g;
    colorsRed[3 * i + 2] = rd.b;

    // 紫域
    const vi = new Color();
    const vp = Math.random();
    if (vp < 0.1) vi.set('#ffffff');
    else if (vp < 0.4) vi.set('#e0aaff');
    else if (vp < 0.7) vi.set('#9d4edd');
    else if (vp < 0.85) vi.set('#ff00aa');
    else vi.set('#10001a');
    colorsViolet[3 * i] = vi.r;
    colorsViolet[3 * i + 1] = vi.g;
    colorsViolet[3 * i + 2] = vi.b;
  }

  return { count, positions, colorsBase, colorsCyan, colorsRed, colorsViolet };
}

// ---------------------------------------------------------------------------
// 6. 突触与连线（三个系统的共享构建器）
// ---------------------------------------------------------------------------

/**
 * 从点阵中抽取 N 个不重复采样点作为突触节点。
 * brightPicker: (randomValue) => Color —— 单色高亮选择器
 * 返回节点对象数组（含原始位置快照与位移缓冲），供逐帧鼠标扰动使用。
 */
export function buildSynapses(pointPositions, totalPoints, count, baseHex, brightPicker) {
  const picked = new Set();
  while (picked.size < count) picked.add(Math.floor(Math.random() * totalPoints));
  const indices = Array.from(picked);

  const synapses = [];
  const positions = new Float32Array(count * 3);
  const colorsBase = new Float32Array(count * 3);
  const colorsBright = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const idx = indices[i];
    const x = pointPositions[3 * idx];
    const y = pointPositions[3 * idx + 1];
    const z = pointPositions[3 * idx + 2];
    synapses.push({ x, y, z, ox: x, oy: y, oz: z, rx: 0, ry: 0, rz: 0 });
    positions[3 * i] = x;
    positions[3 * i + 1] = y;
    positions[3 * i + 2] = z;

    const base = new Color(baseHex);
    colorsBase[3 * i] = base.r;
    colorsBase[3 * i + 1] = base.g;
    colorsBase[3 * i + 2] = base.b;

    const bright = brightPicker(Math.random());
    colorsBright[3 * i] = bright.r;
    colorsBright[3 * i + 1] = bright.g;
    colorsBright[3 * i + 2] = bright.b;
  }

  return { synapses, positions, colorsBase, colorsBright };
}

/**
 * 连线：每个突触连接最近的 maxNeighbors 个邻居（距离阈值内）。
 * pairPicker: (randomValue) => [ColorA, ColorB] —— 每对连线共享一套高亮配色
 * 返回端点索引对、初始线段位置与两套配色（基础 / 高亮）。
 */
export function buildConnections(synapses, maxNeighbors, maxDist, colorAHex, colorBHex, pairPicker) {
  const pairs = [];
  for (let i = 0; i < synapses.length; i++) {
    const a = synapses[i];
    const candidates = synapses
      .map((b, idx) => ({
        idx,
        dist: Math.sqrt(Math.pow(a.ox - b.ox, 2) + Math.pow(a.oy - b.oy, 2) + Math.pow(a.oz - b.oz, 2))
      }))
      .filter((c) => c.idx !== i);
    candidates.sort((p, q) => p.dist - q.dist);
    const n = Math.min(maxNeighbors, candidates.length);
    for (let j = 0; j < n; j++) {
      if (candidates[j].dist < maxDist) pairs.push({ a: i, b: candidates[j].idx });
    }
  }

  const linePositions = new Float32Array(pairs.length * 6);
  const colorsBase = new Float32Array(pairs.length * 6);
  const colorsBright = new Float32Array(pairs.length * 6);
  const colorA = new Color(colorAHex);
  const colorB = new Color(colorBHex);

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const na = synapses[p.a];
    const nb = synapses[p.b];
    linePositions[6 * i] = na.x;
    linePositions[6 * i + 1] = na.y;
    linePositions[6 * i + 2] = na.z;
    linePositions[6 * i + 3] = nb.x;
    linePositions[6 * i + 4] = nb.y;
    linePositions[6 * i + 5] = nb.z;

    colorsBase[6 * i] = colorA.r;
    colorsBase[6 * i + 1] = colorA.g;
    colorsBase[6 * i + 2] = colorA.b;
    colorsBase[6 * i + 3] = colorB.r;
    colorsBase[6 * i + 4] = colorB.g;
    colorsBase[6 * i + 5] = colorB.b;

    const [brightA, brightB] = pairPicker(Math.random());
    colorsBright[6 * i] = brightA.r;
    colorsBright[6 * i + 1] = brightA.g;
    colorsBright[6 * i + 2] = brightA.b;
    colorsBright[6 * i + 3] = brightB.r;
    colorsBright[6 * i + 4] = brightB.g;
    colorsBright[6 * i + 5] = brightB.b;
  }

  return { pairs, linePositions, colorsBase, colorsBright };
}
