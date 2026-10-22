/**
 * 场景模块 — Three.js 渲染管线 + 滚动时间轴 + 鼠标交互
 *
 * 行为基准：doc/restore-spec.md 第 3 节
 *   - 渲染：WebGLRenderer(antialias) + EffectComposer(RenderPass + UnrealBloomPass)
 *   - 相机：PerspectiveCamera(60, aspect, 0.1, 100)，z = 24
 *   - 时间轴：progress = scrollY / (scrollHeight - innerHeight)，平滑系数 0.08
 *   - 五套粒子系统按 progress 分段显隐 / 缩放 / 变色 / 换位
 *
 * 对外接口：
 *   createScene({ container, onTimeline }) => { dispose }
 *   onTimeline(t, frame) 每帧回调，供 DOM 覆盖层做相位切换（与参考实现一致）
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createPerlin3D } from './noise.js';
import { createSoftSprite, createStarSprite } from './sprites.js';
import {
  buildBoneSystem,
  buildConnections,
  buildFaceStarfield,
  buildNebula,
  buildSkullSystem,
  buildSynapses,
  buildSynthesisFigure
} from './geometry.js';

/** 鼠标扰动作用半径（face / figure / bone / skull） */
const POINTER_RADIUS = 6;
/** 星云扰动半径 */
const NEBULA_RADIUS = 9;

/** 一次性构建全部突触 + 连线的辅助封装 */
function buildSynapsePair(pointPositions, totalPoints, { count, baseHex, brightPick, neighbors, maxDist, lineHexA, lineHexB, pairPick }) {
  const { synapses, positions, colorsBase, colorsBright } = buildSynapses(
    pointPositions,
    totalPoints,
    count,
    baseHex,
    brightPick
  );
  const { pairs, linePositions, colorsBase: lineBase, colorsBright: lineBright } = buildConnections(
    synapses,
    neighbors,
    maxDist,
    lineHexA,
    lineHexB,
    pairPick
  );
  return { synapses, positions, colorsBase, colorsBright, pairs, linePositions, lineBase, lineBright };
}

export function createScene({ container, onTimeline }) {
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  const noise = createPerlin3D();

  // ----- 渲染管线 -----
  const scene = new Scene();
  scene.background = new Color('#000000');
  const camera = new PerspectiveCamera(60, width / height, 0.1, 100);
  camera.position.z = 24;

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(width, height), 0.55, 0.18, 0.35);
  composer.addPass(bloom);

  const softSprite = createSoftSprite();
  const starSprite = createStarSprite();

  // ----- 系统 1：人脸星域 -----
  const faceData = buildFaceStarfield();
  const faceGeometry = new BufferGeometry();
  faceGeometry.setAttribute('position', new BufferAttribute(faceData.positions, 3));
  faceGeometry.setAttribute('color', new BufferAttribute(faceData.colors, 3));
  const faceMaterial = new PointsMaterial({
    size: 0.16,
    map: starSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.9
  });
  const facePoints = new Points(faceGeometry, faceMaterial);
  scene.add(facePoints);

  /** 通用位移缓冲：原始点 + 位移（lerp 0.12 趋近目标） */
  const faceOrigins = new Float32Array(faceData.positions);
  const faceOffsets = new Float32Array(faceData.pointCount * 3);

  // ----- 系统 2：人形点阵 -----
  const figureData = buildSynthesisFigure(noise);
  const figureGeometry = new BufferGeometry();
  figureGeometry.setAttribute('position', new BufferAttribute(figureData.positions, 3));
  figureGeometry.setAttribute('color', new BufferAttribute(figureData.colorsBase, 3));
  const figureMaterial = new PointsMaterial({
    size: 0.09,
    map: starSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const figurePoints = new Points(figureGeometry, figureMaterial);
  const figureOrigins = new Float32Array(figureData.positions);
  const figureOffsets = new Float32Array(figureData.totalPoints * 3);

  const figureSyn = buildSynapsePair(figureData.positions, 15000, {
    count: 280,
    baseHex: '#ffffff',
    brightPick: (r) => {
      const c = new Color();
      if (r < 0.6) c.set('#ffffff');
      else if (r < 0.8) c.set('#b6ffff');
      else c.set('#f2d9ff');
      return c;
    },
    neighbors: 3,
    maxDist: 2.1,
    lineHexA: '#00ffff',
    lineHexB: '#0055ff',
    pairPick: (r) => {
      const a = new Color();
      const b = new Color();
      if (r < 0.4) {
        a.set('#ffffff');
        b.set('#9bf6ff');
      } else if (r < 0.7) {
        a.set('#9bf6ff');
        b.set('#ffd1ff');
      } else {
        a.set('#00a2ff');
        b.set('#ffffff');
      }
      return [a, b];
    }
  });
  const figureSynGeometry = new BufferGeometry();
  figureSynGeometry.setAttribute('position', new BufferAttribute(figureSyn.positions, 3));
  figureSynGeometry.setAttribute('color', new BufferAttribute(figureSyn.colorsBase, 3));
  const figureSynMaterial = new PointsMaterial({
    size: 0.42,
    map: softSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const figureSynPoints = new Points(figureSynGeometry, figureSynMaterial);

  const figureLineGeometry = new BufferGeometry();
  figureLineGeometry.setAttribute('position', new BufferAttribute(figureSyn.linePositions, 3));
  figureLineGeometry.setAttribute('color', new BufferAttribute(figureSyn.lineBase, 3));
  const figureLineMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false
  });
  const figureLines = new LineSegments(figureLineGeometry, figureLineMaterial);

  const figureGroup = new Group();
  figureGroup.add(figurePoints);
  figureGroup.add(figureSynPoints);
  figureGroup.add(figureLines);
  figureGroup.rotation.y = Math.PI / 4.5;
  figureGroup.rotation.x = 0.15;
  figureGroup.scale.setScalar(0.1);
  scene.add(figureGroup);

  // ----- 系统 3：骨架 -----
  const boneData = buildBoneSystem(noise);
  const boneGeometry = new BufferGeometry();
  boneGeometry.setAttribute('position', new BufferAttribute(boneData.positions, 3));
  boneGeometry.setAttribute('color', new BufferAttribute(boneData.colorsBase, 3));
  const boneMaterial = new PointsMaterial({
    size: 0.11,
    map: starSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const bonePoints = new Points(boneGeometry, boneMaterial);
  const boneOrigins = new Float32Array(boneData.positions);
  const boneOffsets = new Float32Array(boneData.totalPoints * 3);

  const boneSyn = buildSynapsePair(boneData.positions, boneData.totalPoints, {
    count: 180,
    baseHex: '#ff1a40',
    brightPick: (r) => {
      const c = new Color();
      if (r < 0.5) c.set('#ffffff');
      else if (r < 0.85) c.set('#ff1a40');
      else c.set('#ff8093');
      return c;
    },
    neighbors: 3,
    maxDist: 2.4,
    lineHexA: '#ff002c',
    lineHexB: '#ff3355',
    pairPick: (r) => {
      const a = new Color();
      const b = new Color();
      if (r < 0.5) {
        a.set('#ffffff');
        b.set('#ff0000');
      } else {
        a.set('#ff1a40');
        b.set('#ff8093');
      }
      return [a, b];
    }
  });
  const boneSynGeometry = new BufferGeometry();
  boneSynGeometry.setAttribute('position', new BufferAttribute(boneSyn.positions, 3));
  boneSynGeometry.setAttribute('color', new BufferAttribute(boneSyn.colorsBase, 3));
  const boneSynMaterial = new PointsMaterial({
    size: 0.42,
    map: softSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const boneSynPoints = new Points(boneSynGeometry, boneSynMaterial);

  const boneLineGeometry = new BufferGeometry();
  boneLineGeometry.setAttribute('position', new BufferAttribute(boneSyn.linePositions, 3));
  boneLineGeometry.setAttribute('color', new BufferAttribute(boneSyn.lineBase, 3));
  const boneLineMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false
  });
  const boneLines = new LineSegments(boneLineGeometry, boneLineMaterial);

  const boneGroup = new Group();
  boneGroup.add(bonePoints);
  boneGroup.add(boneSynPoints);
  boneGroup.add(boneLines);
  boneGroup.rotation.y = Math.PI / 6;
  boneGroup.rotation.x = 0.1;
  boneGroup.scale.setScalar(0.1);
  scene.add(boneGroup);

  // ----- 系统 4：头骨 -----
  const skullData = buildSkullSystem(noise);
  const skullGeometry = new BufferGeometry();
  skullGeometry.setAttribute('position', new BufferAttribute(skullData.positions, 3));
  skullGeometry.setAttribute('color', new BufferAttribute(skullData.colorsBase, 3));
  const skullMaterial = new PointsMaterial({
    size: 0.11,
    map: starSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const skullPoints = new Points(skullGeometry, skullMaterial);
  const skullOrigins = new Float32Array(skullData.positions);
  const skullOffsets = new Float32Array(skullData.totalPoints * 3);

  const skullSyn = buildSynapsePair(skullData.positions, skullData.totalPoints, {
    count: 220,
    baseHex: '#9d4edd',
    brightPick: (r) => {
      const c = new Color();
      if (r < 0.5) c.set('#ffffff');
      else if (r < 0.85) c.set('#ff007f');
      else c.set('#ff80df');
      return c;
    },
    neighbors: 2,
    maxDist: 1.95,
    lineHexA: '#7b2cbf',
    lineHexB: '#9d4edd',
    pairPick: (r) => {
      const a = new Color();
      const b = new Color();
      if (r < 0.5) {
        a.set('#ffffff');
        b.set('#ff007f');
      } else {
        a.set('#e0aaff');
        b.set('#ff5c8a');
      }
      return [a, b];
    }
  });
  const skullSynGeometry = new BufferGeometry();
  skullSynGeometry.setAttribute('position', new BufferAttribute(skullSyn.positions, 3));
  skullSynGeometry.setAttribute('color', new BufferAttribute(skullSyn.colorsBase, 3));
  const skullSynMaterial = new PointsMaterial({
    size: 0.42,
    map: softSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0
  });
  const skullSynPoints = new Points(skullSynGeometry, skullSynMaterial);

  const skullLineGeometry = new BufferGeometry();
  skullLineGeometry.setAttribute('position', new BufferAttribute(skullSyn.linePositions, 3));
  skullLineGeometry.setAttribute('color', new BufferAttribute(skullSyn.lineBase, 3));
  const skullLineMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false
  });
  const skullLines = new LineSegments(skullLineGeometry, skullLineMaterial);

  const skullGroup = new Group();
  skullGroup.add(skullPoints);
  skullGroup.add(skullSynPoints);
  skullGroup.add(skullLines);
  skullGroup.rotation.y = -Math.PI / 6;
  skullGroup.rotation.x = 0.05;
  skullGroup.scale.setScalar(0.1);
  scene.add(skullGroup);

  // ----- 系统 5：星云 -----
  const nebulaData = buildNebula();
  const nebulaGeometry = new BufferGeometry();
  nebulaGeometry.setAttribute('position', new BufferAttribute(nebulaData.positions, 3));
  nebulaGeometry.setAttribute('color', new BufferAttribute(nebulaData.colorsBase, 3));
  const nebulaMaterial = new PointsMaterial({
    size: 0.26,
    map: starSprite,
    vertexColors: true,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.95
  });
  const nebulaPoints = new Points(nebulaGeometry, nebulaMaterial);
  scene.add(nebulaPoints);

  const nebulaOrigins = new Float32Array(nebulaData.positions);
  const nebulaOffsets = new Float32Array(nebulaData.count * 3);

  // 变色缓存（每帧仅在进度变化超过阈值时重算）
  const nebulaPalette = {
    base: nebulaData.colorsBase,
    cyan: nebulaData.colorsCyan,
    red: nebulaData.colorsRed,
    violet: nebulaData.colorsViolet
  };

  // ----- 鼠标与滚动 -----
  const pointerNDC = new Vector2(-9999, -9999);
  const raycasterPoint = new Vector3(-9999, -9999, -9999);
  let pointerActive = false;

  const onMouseMove = (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -(2 * ((event.clientY - rect.top) / rect.height)) + 1;
    pointerActive = true;
  };
  const onMouseLeave = () => {
    pointerActive = false;
    pointerNDC.set(-9999, -9999);
  };
  window.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('mouseleave', onMouseLeave);

  let scrollProgress = 0;
  const updateScroll = () => {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    if (total > 0) scrollProgress = window.scrollY / total;
  };
  window.addEventListener('scroll', updateScroll, { passive: true });

  // ----- 动画循环 -----
  let rafId;
  let smoothed = 0;
  let lastColorProgress = -1;
  const clock = { start: performance.now() };

  const lerp3 = (target, current, alpha) => current + (target - current) * alpha;

  /** 对一组点阵施加鼠标斥力（与原实现一致的力场公式） */
  function applyPointerForce(positions, origins, offsets, count, localPointer, elapsed) {
    const attr = positions;
    const array = attr.array;
    for (let i = 0; i < count; i++) {
      const a = 3 * i;
      const sx = origins[a];
      const sy = origins[a + 1];
      const sz = origins[a + 2];
      const dx = sx - localPointer.x;
      const dy = sy - localPointer.y;
      const dz = sz - localPointer.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let fx = 0;
      let fy = 0;
      let fz = 0;
      if (dist < POINTER_RADIUS && dist > 0.01) {
        const e = 1 - dist / POINTER_RADIUS;
        const push = e * e * 3.2;
        const ripple = 0.35 * Math.sin(7.5 * elapsed + 4 * dist) * e;
        fx = (dx / dist) * (push + ripple);
        fy = (dy / dist) * (push + ripple);
        fz = (dz / dist) * (push + ripple);
      }
      offsets[a] = lerp3(fx, offsets[a], 0.12);
      offsets[a + 1] = lerp3(fy, offsets[a + 1], 0.12);
      offsets[a + 2] = lerp3(fz, offsets[a + 2], 0.12);
      array[a] = sx + offsets[a];
      array[a + 1] = sy + offsets[a + 1];
      array[a + 2] = sz + offsets[a + 2];
    }
    attr.needsUpdate = true;
  }

  /** 突触节点扰动 + 同步刷新连线端点 */
  function applySynapseForce(synapses, synGeometry, lineGeometry, linePairs, localPointer, elapsed) {
    const synAttr = synGeometry.attributes.position;
    const synArray = synAttr.array;
    const lineAttr = lineGeometry.attributes.position;
    const lineArray = lineAttr.array;
    for (let i = 0; i < synapses.length; i++) {
      const s = synapses[i];
      const dx = s.ox - localPointer.x;
      const dy = s.oy - localPointer.y;
      const dz = s.oz - localPointer.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let fx = 0;
      let fy = 0;
      let fz = 0;
      if (dist < POINTER_RADIUS && dist > 0.01) {
        const e = 1 - dist / POINTER_RADIUS;
        const push = e * e * 3.2;
        const ripple = 0.35 * Math.sin(7.5 * elapsed + 4 * dist) * e;
        fx = (dx / dist) * (push + ripple);
        fy = (dy / dist) * (push + ripple);
        fz = (dz / dist) * (push + ripple);
      }
      s.rx = lerp3(fx, s.rx, 0.12);
      s.ry = lerp3(fy, s.ry, 0.12);
      s.rz = lerp3(fz, s.rz, 0.12);
      s.x = s.ox + s.rx;
      s.y = s.oy + s.ry;
      s.z = s.oz + s.rz;
      synArray[3 * i] = s.x;
      synArray[3 * i + 1] = s.y;
      synArray[3 * i + 2] = s.z;
    }
    synAttr.needsUpdate = true;
    for (let i = 0; i < linePairs.length; i++) {
      const p = linePairs[i];
      const a = synapses[p.a];
      const b = synapses[p.b];
      lineArray[6 * i] = a.x;
      lineArray[6 * i + 1] = a.y;
      lineArray[6 * i + 2] = a.z;
      lineArray[6 * i + 3] = b.x;
      lineArray[6 * i + 4] = b.y;
      lineArray[6 * i + 5] = b.z;
    }
    lineAttr.needsUpdate = true;
  }

  /** 星云：逐点噪声漂移 + 鼠标斥力 + 随进度放大壳层 */
  function applyNebula(elapsed, progress, localPointer) {
    const attr = nebulaGeometry.attributes.position;
    const array = attr.array;
    const scale = 1 + 1.6 * progress;
    const t = 0.25 * elapsed;
    for (let i = 0; i < nebulaData.count; i++) {
      const a = 3 * i;
      const ox = nebulaOrigins[a];
      const oy = nebulaOrigins[a + 1];
      const oz = nebulaOrigins[a + 2];
      const px = ox * scale;
      const py = oy * scale;
      const pz = oz * scale;
      const n1 = 0.35 * noise(0.085 * px, 0.085 * py, 0.085 * pz + t);
      const n2 = 0.35 * noise(0.085 * py, 0.085 * pz, 0.085 * px + 1.15 * t);
      const n3 = 0.35 * noise(0.085 * pz, 0.085 * px, 0.085 * py + 0.9 * t);
      const dx = px + n1;
      const dy = py + n2;
      const dz = pz + n3;
      const mx = dx - localPointer.x;
      const my = dy - localPointer.y;
      const mz = dz - localPointer.z;
      const dist = Math.sqrt(mx * mx + my * my + mz * mz);
      let fx = 0;
      let fy = 0;
      let fz = 0;
      if (dist < NEBULA_RADIUS && dist > 0.01) {
        const e = 1 - dist / NEBULA_RADIUS;
        const push = e * e * 7.5;
        const ripple = 0.55 * Math.sin(5 * elapsed + 3 * dist) * e;
        fx = (mx / dist) * (push + ripple);
        fy = (my / dist) * (push + ripple);
        fz = (mz / dist) * (push + ripple);
      }
      nebulaOffsets[a] = lerp3(fx, nebulaOffsets[a], 0.08);
      nebulaOffsets[a + 1] = lerp3(fy, nebulaOffsets[a + 1], 0.08);
      nebulaOffsets[a + 2] = lerp3(fz, nebulaOffsets[a + 2], 0.08);
      array[a] = dx + nebulaOffsets[a];
      array[a + 1] = dy + nebulaOffsets[a + 1];
      array[a + 2] = dz + nebulaOffsets[a + 2];
    }
    attr.needsUpdate = true;
  }

  /** 星云按滚动进度在四套色板间插值 */
  function updateNebulaColors(progress) {
    if (Math.abs(progress - lastColorProgress) <= 0.001) return;
    lastColorProgress = progress;
    const colorAttr = nebulaGeometry.attributes.color;
    const array = colorAttr.array;
    const { base, cyan, red, violet } = nebulaPalette;
    const len = array.length;
    let from = base;
    let to = base;
    let mix = 0;
    if (progress < 0.3) {
      from = base;
      to = base;
      mix = 0;
    } else if (progress < 0.45) {
      from = base;
      to = cyan;
      mix = (progress - 0.3) / 0.15;
    } else if (progress < 0.62) {
      from = cyan;
      to = cyan;
      mix = 0;
    } else if (progress < 0.82) {
      from = cyan;
      to = red;
      mix = (progress - 0.62) / 0.2;
    } else if (progress < 0.9) {
      from = red;
      to = red;
      mix = 0;
    } else if (progress < 0.98) {
      from = red;
      to = violet;
      mix = (progress - 0.9) / 0.08;
    } else {
      from = violet;
      to = violet;
      mix = 0;
    }
    for (let i = 0; i < len; i++) {
      array[i] = from[i] + (to[i] - from[i]) * mix;
    }
    colorAttr.needsUpdate = true;
  }

  /** 点阵双色插值（原色 → 高亮），用于 figure / bone / skull 的滚动变色 */
  function updatePointColors(geometry, colorsBase, colorsBright, mix) {
    const attr = geometry.attributes.color;
    const array = attr.array;
    for (let i = 0; i < array.length; i++) {
      array[i] = colorsBase[i] + (colorsBright[i] - colorsBase[i]) * mix;
    }
    attr.needsUpdate = true;
  }

  /** 逐帧主循环 — 所有相位数值逐一对应还原基准第 3.4 节 */
  function tick() {
    rafId = requestAnimationFrame(tick);
    const elapsed = (performance.now() - clock.start) / 1000;
    smoothed += (scrollProgress - smoothed) * 0.08;
    const t = smoothed;

    // —— 人脸星域：放大逼近 + 淡出 ——
    const faceZoom = Math.min(1, t / 0.2);
    facePoints.scale.setScalar(1 + 6.5 * faceZoom);
    let faceOpacity = 0;
    if (t < 0.26) faceOpacity = 0.9 * (1 - Math.min(1, Math.max(0, (t - 0.1) / 0.14)));
    faceMaterial.opacity = faceOpacity;

    // —— 人形点阵相位 ——
    let synOpacity = 0;
    let figOpacity = 0;
    let figScale = 0.1;
    if (t >= 0.26 && t < 0.44) {
      const e = (t - 0.26) / 0.18;
      synOpacity = e;
      figOpacity = 0.9 * e;
      figScale = 0.1 + 1.65 * e;
    } else if (t >= 0.44 && t < 0.52) {
      synOpacity = 1;
      figOpacity = 0.9;
      figScale = 1.75;
    } else if (t >= 0.52 && t < 0.64) {
      const e = (t - 0.52) / 0.12;
      synOpacity = 1 - e;
      figOpacity = 0.9 * (1 - e);
      figScale = 1.75 + 4.5 * e;
    } else if (t >= 0.64) {
      synOpacity = 0;
      figOpacity = 0;
      figScale = 6.25;
    }
    figureGroup.scale.setScalar(figScale);
    figureMaterial.opacity = figOpacity;
    figureSynMaterial.opacity = synOpacity;
    figureLineMaterial.opacity = 0.55 * synOpacity;

    // —— 骨架相位 ——
    let boneSynOpacity = 0;
    let boneOpacity = 0;
    let boneScale = 0.1;
    if (t >= 0.62 && t < 0.78) {
      const e = (t - 0.62) / 0.16;
      boneSynOpacity = e;
      boneOpacity = 0.95 * e;
      boneScale = 0.1 + 1.55 * e;
    } else if (t >= 0.78 && t < 0.84) {
      boneSynOpacity = 1;
      boneOpacity = 0.95;
      boneScale = 1.65;
    } else if (t >= 0.84 && t < 0.92) {
      const e = (t - 0.84) / 0.08;
      boneSynOpacity = 1 - e;
      boneOpacity = 0.95 * (1 - e);
      boneScale = 1.65 + 4.5 * e;
    } else if (t >= 0.92) {
      boneSynOpacity = 0;
      boneOpacity = 0;
      boneScale = 6.15;
    }
    boneGroup.scale.setScalar(boneScale);
    boneMaterial.opacity = boneOpacity;
    boneSynMaterial.opacity = boneSynOpacity;
    boneLineMaterial.opacity = 0.55 * boneSynOpacity;

    // —— 头骨相位 ——
    let skullSynOpacity = 0;
    let skullOpacity = 0;
    let skullScale = 0.1;
    if (t >= 0.9 && t < 0.98) {
      const e = (t - 0.9) / 0.08;
      skullSynOpacity = e;
      skullOpacity = 0.95 * e;
      skullScale = 0.1 + 1.6 * e;
    } else if (t >= 0.98) {
      skullSynOpacity = 1;
      skullOpacity = 0.95;
      skullScale = 1.7;
    }
    skullGroup.scale.setScalar(skullScale);
    skullMaterial.opacity = skullOpacity;
    skullSynMaterial.opacity = skullSynOpacity;
    skullLineMaterial.opacity = 0.55 * skullSynOpacity;

    // —— 星云：常亮 + 缓慢自转 + 进度变色 ——
    nebulaPoints.rotation.y += 0.001;
    updateNebulaColors(t);

    // —— 点阵变色（人形 / 骨架 / 头骨） ——
    if (t >= 0.26 && t < 0.44) {
      const e = Math.min(1, (t - 0.26) / 0.18);
      updatePointColors(figureGeometry, figureData.colorsBase, figureData.colorsBright, e);
      updatePointColors(figureSynGeometry, figureSyn.colorsBase, figureSyn.colorsBright, e);
      updatePointColors(figureLineGeometry, figureSyn.lineBase, figureSyn.lineBright, e);
    }
    if (t >= 0.62 && t < 0.78) {
      const e = Math.min(1, (t - 0.62) / 0.16);
      updatePointColors(boneGeometry, boneData.colorsBase, boneData.colorsBright, e);
      updatePointColors(boneSynGeometry, boneSyn.colorsBase, boneSyn.colorsBright, e);
      updatePointColors(boneLineGeometry, boneSyn.lineBase, boneSyn.lineBright, e);
    }
    if (t >= 0.9 && t < 0.98) {
      const e = Math.min(1, (t - 0.9) / 0.08);
      updatePointColors(skullGeometry, skullData.colorsBase, skullData.colorsBright, e);
      updatePointColors(skullSynGeometry, skullSyn.colorsBase, skullSyn.colorsBright, e);
      updatePointColors(skullLineGeometry, skullSyn.lineBase, skullSyn.lineBright, e);
    }

    // —— 视差旋转（按系统活跃度生效） ——
    if (faceOpacity > 0.01) {
      const targetY = pointerActive ? 0.22 * pointerNDC.x : 0;
      const targetX = pointerActive ? -(0.22 * pointerNDC.y) : 0;
      facePoints.rotation.y = lerp3(targetY, facePoints.rotation.y, 0.06);
      facePoints.rotation.x = lerp3(targetX, facePoints.rotation.x, 0.06);
      facePoints.rotation.z = lerp3(0, facePoints.rotation.z, 0.06);
    }
    if (figOpacity > 0.01) {
      const targetY = -Math.PI / 4.5 + (pointerActive ? 0.3 * pointerNDC.x : 0);
      const targetX = 0.08 + (pointerActive ? -(0.3 * pointerNDC.y) : 0);
      figureGroup.rotation.y = lerp3(targetY, figureGroup.rotation.y, 0.06);
      figureGroup.rotation.x = lerp3(targetX, figureGroup.rotation.x, 0.06);
    }
    if (boneOpacity > 0.01) {
      const targetY = Math.PI / 6 + (pointerActive ? 0.35 * pointerNDC.x : 0);
      const targetX = 0.1 + (pointerActive ? -(0.35 * pointerNDC.y) : 0);
      boneGroup.rotation.y = lerp3(targetY, boneGroup.rotation.y, 0.06);
      boneGroup.rotation.x = lerp3(targetX, boneGroup.rotation.x, 0.06);
    }
    if (skullOpacity > 0.01) {
      const targetY = -Math.PI / 6 + (pointerActive ? 0.35 * pointerNDC.x : 0);
      const targetX = 0.05 + (pointerActive ? -(0.35 * pointerNDC.y) : 0);
      skullGroup.rotation.y = lerp3(targetY, skullGroup.rotation.y, 0.06);
      skullGroup.rotation.x = lerp3(targetX, skullGroup.rotation.x, 0.06);
    }

    // —— 光标世界坐标（投影到 z=相机前方平面） ——
    if (pointerActive) {
      const ndc = new Vector3(pointerNDC.x, pointerNDC.y, 0.5);
      ndc.unproject(camera);
      const dir = ndc.sub(camera.position).normalize();
      const distance = -camera.position.z / dir.z;
      const worldPoint = camera.position.clone().add(dir.multiplyScalar(distance));
      raycasterPoint.lerp(worldPoint, 0.1);
    } else {
      raycasterPoint.lerp(new Vector3(-9999, -9999, -9999), 0.1);
    }

    // —— 鼠标扰动（逐系统，仅活跃时计算） ——
    if (faceOpacity > 0.01) {
      const local = new Vector3().copy(raycasterPoint);
      facePoints.worldToLocal(local);
      applyPointerForce(faceGeometry.attributes.position, faceOrigins, faceOffsets, faceData.pointCount, local, elapsed);
    }
    if (figOpacity > 0.01) {
      const local = new Vector3().copy(raycasterPoint);
      figurePoints.worldToLocal(local);
      applyPointerForce(figureGeometry.attributes.position, figureOrigins, figureOffsets, figureData.totalPoints, local, elapsed);
      const synLocal = new Vector3().copy(raycasterPoint);
      figureSynPoints.worldToLocal(synLocal);
      applySynapseForce(figureSyn.synapses, figureSynGeometry, figureLineGeometry, figureSyn.pairs, synLocal, elapsed);
    }
    if (boneOpacity > 0.01) {
      const local = new Vector3().copy(raycasterPoint);
      bonePoints.worldToLocal(local);
      applyPointerForce(boneGeometry.attributes.position, boneOrigins, boneOffsets, boneData.totalPoints, local, elapsed);
      const synLocal = new Vector3().copy(raycasterPoint);
      boneSynPoints.worldToLocal(synLocal);
      applySynapseForce(boneSyn.synapses, boneSynGeometry, boneLineGeometry, boneSyn.pairs, synLocal, elapsed);
    }
    if (skullOpacity > 0.01) {
      const local = new Vector3().copy(raycasterPoint);
      skullPoints.worldToLocal(local);
      applyPointerForce(skullGeometry.attributes.position, skullOrigins, skullOffsets, skullData.totalPoints, local, elapsed);
      const synLocal = new Vector3().copy(raycasterPoint);
      skullSynPoints.worldToLocal(synLocal);
      applySynapseForce(skullSyn.synapses, skullSynGeometry, skullLineGeometry, skullSyn.pairs, synLocal, elapsed);
    }

    // —— 星云常时更新 ——
    {
      const local = new Vector3().copy(raycasterPoint);
      nebulaPoints.worldToLocal(local);
      applyNebula(elapsed, t, local);
    }

    // —— DOM 覆盖层相位回调 ——
    if (onTimeline) onTimeline(t, elapsed);

    composer.render();
  }

  tick();

  // ----- 自适应 -----
  const resizeObserver = new ResizeObserver((entries) => {
    window.requestAnimationFrame(() => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (!w || !h) continue;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        composer.setSize(w, h);
      }
    });
  });
  resizeObserver.observe(container);

  // ----- 销毁 -----
  function dispose() {
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('scroll', updateScroll);
    renderer.domElement.removeEventListener('mouseleave', onMouseLeave);
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    faceGeometry.dispose();
    faceMaterial.dispose();
    figureGeometry.dispose();
    figureMaterial.dispose();
    figureSynGeometry.dispose();
    figureSynMaterial.dispose();
    figureLineGeometry.dispose();
    figureLineMaterial.dispose();
    boneGeometry.dispose();
    boneMaterial.dispose();
    boneSynGeometry.dispose();
    boneSynMaterial.dispose();
    boneLineGeometry.dispose();
    boneLineMaterial.dispose();
    skullGeometry.dispose();
    skullMaterial.dispose();
    skullSynGeometry.dispose();
    skullSynMaterial.dispose();
    skullLineGeometry.dispose();
    skullLineMaterial.dispose();
    nebulaGeometry.dispose();
    nebulaMaterial.dispose();
    softSprite.dispose();
    starSprite.dispose();
    composer.dispose();
    renderer.dispose();
  }

  return { dispose };
}
