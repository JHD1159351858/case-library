import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
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
  Vector3
} from '../../project/frontend/libs/three/three.module.js';

const sceneSource = readFileSync(new URL('../../project/frontend/js/scene.js', import.meta.url), 'utf8');
const noiseSource = readFileSync(new URL('../../project/frontend/js/noise.js', import.meta.url), 'utf8');

const eventTarget = () => {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event = {}) { listeners.get(type)?.(event); }
  };
};

const pointData = () => ({
  positions: new Float32Array([0, 0, 0]),
  colorsBase: new Float32Array([0, 0, 0]),
  colorsBright: new Float32Array([1, 1, 1]),
  totalPoints: 1
});

function sceneHarness() {
  let now = 1000;
  let nextFrameId = 1;
  const frames = new Map();
  const windowEvents = eventTarget();
  const documentEvents = eventTarget();
  const raf = (callback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  const cancelRaf = (id) => frames.delete(id);
  const step = (time) => {
    now = time;
    const entry = frames.entries().next().value;
    assert.ok(entry, 'expected one pending animation frame');
    frames.delete(entry[0]);
    entry[1](time);
  };

  const document = {
    ...documentEvents,
    hidden: false,
    documentElement: { scrollHeight: 2000 }
  };
  const window = {
    ...windowEvents,
    innerWidth: 1200,
    innerHeight: 1000,
    devicePixelRatio: 1,
    scrollY: 0,
    requestAnimationFrame: raf
  };
  const container = {
    clientWidth: 1200,
    clientHeight: 800,
    appendChild(element) { element.parentNode = this; },
    removeChild(element) { element.parentNode = null; }
  };

  class WebGLRenderer {
    constructor() {
      this.domElement = {
        ...eventTarget(),
        parentNode: null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 })
      };
    }
    setSize() {}
    setPixelRatio() {}
    dispose() {}
  }
  class EffectComposer {
    addPass() {}
    render() {}
    setSize() {}
    dispose() {}
  }
  class RenderPass {}
  class UnrealBloomPass {}
  class ResizeObserver {
    observe() {}
    disconnect() {}
  }

  const buildSynapses = () => ({
    synapses: [{ x: 0, y: 0, z: 0, ox: 0, oy: 0, oz: 0, rx: 0, ry: 0, rz: 0 }],
    positions: new Float32Array([0, 0, 0]),
    colorsBase: new Float32Array([0, 0, 0]),
    colorsBright: new Float32Array([1, 1, 1])
  });
  const buildConnections = () => ({
    pairs: [],
    linePositions: new Float32Array(0),
    colorsBase: new Float32Array(0),
    colorsBright: new Float32Array(0)
  });
  const buildFaceStarfield = () => ({
    positions: new Float32Array([0, 0, 0]),
    colors: new Float32Array([1, 1, 1]),
    pointCount: 1
  });
  const buildNebula = () => ({
    positions: new Float32Array([0, 0, 0]),
    colorsBase: new Float32Array([0, 0, 0]),
    colorsCyan: new Float32Array([0, 1, 1]),
    colorsRed: new Float32Array([1, 0, 0]),
    colorsViolet: new Float32Array([1, 0, 1]),
    count: 1
  });

  const context = createContext({
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
    WebGLRenderer,
    EffectComposer,
    RenderPass,
    UnrealBloomPass,
    ResizeObserver,
    buildBoneSystem: pointData,
    buildConnections,
    buildFaceStarfield,
    buildNebula,
    buildSkullSystem: pointData,
    buildSynapses,
    buildSynthesisFigure: pointData,
    createPerlin3D: () => () => 0,
    createSoftSprite: () => ({ dispose() {} }),
    createStarSprite: () => ({ dispose() {} }),
    cancelAnimationFrame: cancelRaf,
    document,
    performance: { now: () => now },
    requestAnimationFrame: raf,
    window
  });

  let code = sceneSource.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export function createScene', 'function createScene');
  code = code.replace(
    'return { dispose };',
    `return { dispose, __test: {
      facePoints, faceMaterial, faceOffsets,
      figureGroup, figureMaterial, figureSynMaterial, figureLineMaterial,
      boneGroup, boneMaterial, boneSynMaterial, boneLineMaterial,
      skullGroup, skullMaterial, skullSynMaterial, skullLineMaterial,
      updatePointColors,
      setTimeline(value) { scrollProgress = value; smoothed = value; }
    } };`
  );
  runInContext(`${code}\nglobalThis.sceneApi = { createScene };`, context);
  return { createScene: context.sceneApi.createScene, container, document, frames, step, window };
}

test('zero-opacity systems stop drawing while any positive opacity remains visible', () => {
  const rig = sceneHarness();
  const scene = rig.createScene({ container: rig.container });
  const view = scene.__test;

  assert.equal(view.facePoints.visible, true);
  assert.equal(view.figureGroup.visible, false);
  assert.equal(view.boneGroup.visible, false);
  assert.equal(view.skullGroup.visible, false);

  view.setTimeline(0.26000000000000006);
  rig.step(1016);
  assert.ok(view.figureMaterial.opacity > 0 && view.figureMaterial.opacity < 1e-12);
  assert.equal(view.facePoints.visible, false);
  assert.equal(view.figureGroup.visible, true);

  view.setTimeline(0.6200000000000001);
  rig.step(1032);
  assert.ok(view.boneMaterial.opacity > 0 && view.boneMaterial.opacity < 1e-12);
  assert.equal(view.boneGroup.visible, true);

  view.setTimeline(0.9000000000000001);
  rig.step(1048);
  assert.ok(view.skullMaterial.opacity > 0 && view.skullMaterial.opacity < 1e-12);
  assert.equal(view.skullGroup.visible, true);
  scene.dispose();
});

test('point color interpolation caches an identical mix per geometry', () => {
  const rig = sceneHarness();
  const scene = rig.createScene({ container: rig.container });
  const base = new Float32Array([0, 0.5, 1]);
  const bright = new Float32Array([1, 1, 0]);
  const geometryA = new BufferGeometry();
  const geometryB = new BufferGeometry();
  geometryA.setAttribute('color', new BufferAttribute(new Float32Array(3), 3));
  geometryB.setAttribute('color', new BufferAttribute(new Float32Array(3), 3));

  scene.__test.updatePointColors(geometryA, base, bright, 0.25);
  scene.__test.updatePointColors(geometryB, base, bright, 0.25);
  const version = geometryA.attributes.color.version;
  scene.__test.updatePointColors(geometryA, base, bright, 0.25);
  assert.equal(geometryA.attributes.color.version, version);
  assert.equal(geometryB.attributes.color.version, 1);

  scene.__test.updatePointColors(geometryA, base, bright, 0.5);
  assert.equal(geometryA.attributes.color.version, version + 1);
  assert.deepEqual([...geometryA.attributes.color.array], [0.5, 0.75, 0.5]);
  scene.dispose();
});

test('visibility pauses one RAF without resetting time or state and dispose prevents restart', () => {
  const rig = sceneHarness();
  const timeline = [];
  const scene = rig.createScene({ container: rig.container, onTimeline: (progress, elapsed) => timeline.push([progress, elapsed]) });
  rig.window.scrollY = 1000;
  rig.window.dispatch('scroll');
  for (const time of [1100, 1200, 1300, 1400]) rig.step(time);
  const progressBeforePause = timeline.at(-1)[0];
  scene.__test.faceOffsets[0] = 0.75;

  rig.document.hidden = true;
  rig.document.dispatch('visibilitychange');
  assert.equal(rig.frames.size, 0);
  rig.document.hidden = false;
  rig.document.dispatch('visibilitychange');
  rig.document.dispatch('visibilitychange');
  assert.equal(rig.frames.size, 1);
  rig.step(5100);
  assert.ok(timeline.at(-1)[0] > progressBeforePause);
  assert.equal(timeline.at(-1)[1], 4.1);
  assert.equal(scene.__test.faceOffsets[0], 0.75);

  scene.dispose();
  rig.document.hidden = true;
  rig.document.dispatch('visibilitychange');
  rig.document.hidden = false;
  rig.document.dispatch('visibilitychange');
  assert.equal(rig.frames.size, 0);
});

test('Perlin noise floors each axis once and preserves seeded output', () => {
  let floors = 0;
  const countedMath = Object.create(Math);
  countedMath.floor = (value) => {
    floors++;
    return Math.floor(value);
  };
  const context = createContext({ Math: countedMath, Uint8Array });
  runInContext(`${noiseSource.replace(/\bexport /g, '')}\nglobalThis.noiseApi = { createPerlin3D };`, context);
  const seeded = (initial) => {
    let value = initial >>> 0;
    return () => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 4294967296);
  };
  const noise = context.noiseApi.createPerlin3D(seeded(0x12345678));

  assert.equal(noise(-1.25, 2.5, 3.75), -0.5612659454345703);
  assert.equal(floors, 3);
  assert.equal(noise(0, 0, 0), 0);
  assert.equal(noise(12.345, -67.89, 0.123), -0.014220541793622962);
});
