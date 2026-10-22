import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const path = new URL('../../project/frontend/js/shader-card.js', import.meta.url);
const settingsPath = new URL('../../project/frontend/js/card-effect-settings.js', import.meta.url);

function eventTarget() {
  const events = new Map();
  return {
    events,
    addEventListener(type, handler) {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      events.get(type)?.delete(handler);
      if (!events.get(type)?.size) events.delete(type);
    },
    emit(type, event = {}) { for (const handler of events.get(type) || []) handler(event); }
  };
}

function scene({ supported = true, compile = true, reduced = false } = {}) {
  const calls = { draws: 0, contextsCreated: 0, shadersDeleted: 0, buffersDeleted: 0, programsDeleted: 0, contextsLost: 0, uniforms: {}, shaderSources: [] };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8, COLOR_BUFFER_BIT: 9,
    createShader: () => ({}), shaderSource(_, source) { calls.shaderSources.push(source); }, compileShader() {}, getShaderParameter: () => compile,
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true,
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, useProgram() {},
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    getUniformLocation: (_, name) => name, uniform1f(name, value) { calls.uniforms[name] = value; },
    uniform2f(name, x, y) { calls.uniforms[name] = [x, y]; },
    uniform3fv(name, values) { calls.uniforms[name] = Array.from(values); },
    viewport() {}, clearColor() {}, clear() {}, drawArrays() { calls.draws++; },
    deleteShader() { calls.shadersDeleted++; }, deleteBuffer() { calls.buffersDeleted++; },
    deleteProgram() { calls.programsDeleted++; },
    getExtension: () => ({ loseContext() { calls.contextsLost++; } })
  };
  const canvas = { style: {}, attributes: {}, width: 0, height: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    getContext: (_, options) => { calls.contextsCreated++; calls.contextOptions = options; return supported ? gl : null; },
    getBoundingClientRect: () => ({ width: 320, height: 480 }),
    remove() { card.children = card.children.filter((node) => node !== this); }
  };
  const card = Object.assign(eventTarget(), {
    style: {}, children: [],
    offsetLeft: 0, offsetTop: 0, offsetWidth: 320, offsetHeight: 480, clientWidth: 320, clientHeight: 480,
    offsetParent: { clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    appendChild(node) { this.children.push(node); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 480 })
  });
  const document = Object.assign(eventTarget(), { hidden: false, createElement: () => canvas });
  const media = Object.assign(eventTarget(), { matches: reduced });
  const frames = new Map();
  let frameId = 0;
  let nextFrameTime = 1000;
  let resize;
  let intersection;
  const observers = [];
  class ResizeObserver {
    constructor(callback) { resize = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  class IntersectionObserver {
    constructor(callback) { intersection = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const context = createContext({ document, window: { devicePixelRatio: 3 },
    performance: { now: () => 1000 }, matchMedia: () => media, ResizeObserver, IntersectionObserver,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  if (existsSync(settingsPath)) runInContext(readFileSync(settingsPath, 'utf8').replace(/\bexport /g, ''), context);
  const source = existsSync(path) ? readFileSync(path, 'utf8') : 'function mountShaderCard() { return () => {}; }';
  runInContext(source.replace(/^import .*;\r?\n/m, '').replace(/\bexport /g, '') + '\nglobalThis.mount = mountShaderCard; globalThis.tilt = typeof mountCardTilt === "function" ? mountCardTilt : () => () => {};', context);
  return { card, canvas, calls, document, media, frames, observers,
    mount: (settings, rank) => context.mount(card, settings, rank),
    tilt: (settings) => context.tilt(card, settings),
    resize: () => resize?.(),
    intersect: (visible) => intersection?.([{ isIntersecting: visible }]),
    frame(time = nextFrameTime + 16) {
      nextFrameTime = time;
      const [id, callback] = frames.entries().next().value || [];
      frames.delete(id);
      callback?.(time);
    }
  };
}

test('Shader 卡片：添加不拦截点击的装饰画布，并限制像素比例', () => {
  const page = scene();
  const dispose = page.mount(1);
  assert.equal(page.card.children.length, 1);
  assert.equal(page.canvas.className, 'shader-card-canvas');
  assert.equal(page.canvas.attributes['aria-hidden'], 'true');
  assert.equal(page.canvas.style.pointerEvents, 'none');
  assert.equal(page.canvas.width, 480);
  assert.equal(page.canvas.height, 720);
  assert.ok(page.calls.draws > 0);
  dispose();
});

test('Shader 卡片：WebGL 不可用或编译失败时可安全回退', () => {
  for (const settings of [{ supported: false }, { compile: false }]) {
    const page = scene(settings);
    assert.doesNotThrow(() => page.mount(2)());
    assert.equal(page.card.children.length, 0);
    assert.equal(page.frames.size, 0);
  }
});

test('Shader 卡片：离开可见区域与页面隐藏时停止绘制，恢复可见后继续', () => {
  const page = scene();
  const dispose = page.mount();
  page.frame();
  assert.equal(page.frames.size, 1);
  page.intersect(false);
  assert.equal(page.frames.size, 0);
  page.intersect(true);
  assert.equal(page.frames.size, 1);
  page.document.hidden = true;
  page.document.emit('visibilitychange');
  assert.equal(page.frames.size, 0);
  page.document.hidden = false;
  page.document.emit('visibilitychange');
  assert.equal(page.frames.size, 1);
  dispose();
});

test('Shader 卡片：减少动态效果时静态绘制且不增强，设置改变后恢复', () => {
  const page = scene({ reduced: true });
  const dispose = page.mount();
  assert.ok(page.calls.draws > 0);
  assert.equal(page.frames.size, 0);
  page.card.emit('pointerenter', { pointerType: 'mouse' });
  assert.equal(page.card.style.transform || '', '');
  assert.equal(page.calls.uniforms.uHover, 0.4);
  const staticMouse = [...page.calls.uniforms.uMouse];
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.deepEqual(page.calls.uniforms.uMouse, staticMouse);
  page.media.matches = false;
  page.media.emit('change');
  assert.equal(page.frames.size, 1);
  dispose();
});

test('Shader 卡片：悬停增强羽流，触屏不增强，不写入其他钩子的 transform', () => {
  const page = scene();
  const dispose = page.mount();
  page.card.style.transform = 'rotateY(8deg)';
  page.card.emit('pointerenter', { pointerType: 'touch' });
  page.frame();
  assert.equal(page.calls.uniforms.uHover, 0.4);
  page.card.emit('pointerenter', { pointerType: 'mouse' });
  page.frame();
  assert.ok(page.calls.uniforms.uHover > 0.4);
  assert.equal(page.card.style.transform, 'rotateY(8deg)');
  page.card.emit('pointerleave');
  page.frame();
  assert.equal(page.card.style.transform, 'rotateY(8deg)');
  dispose();
  assert.equal(page.card.style.transform, 'rotateY(8deg)');
});

test('Shader 卡片：清理停止动画并释放观察器、事件和 WebGL 资源', () => {
  const page = scene();
  const dispose = page.mount(3);
  dispose();
  dispose();
  assert.equal(page.frames.size, 0);
  assert.equal(page.card.children.length, 0);
  assert.equal(page.card.events.size, 0);
  assert.equal(page.document.events.size, 0);
  assert.equal(page.media.events.size, 0);
  assert.ok(page.observers.every((observer) => observer.disconnected));
  assert.equal(page.calls.shadersDeleted, 2);
  assert.equal(page.calls.buffersDeleted, 1);
  assert.equal(page.calls.programsDeleted, 1);
  assert.equal(page.calls.contextsLost, 1);
  const draws = page.calls.draws;
  page.resize();
  assert.equal(page.calls.draws, draws);
});

test('所有卡片倾斜：左右上下方向对应 ±8 度，使用未变形布局边界', () => {
  const page = scene();
  const dispose = page.tilt();
  page.card.emit('pointerenter', { pointerType: 'mouse' });
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.match(page.card.style.transform || '', /rotateX\(8deg\).*rotateY\(8deg\)/);
  page.card.getBoundingClientRect = () => ({ left: -50, top: -50, width: 400, height: 600 });
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 0, clientY: 480 });
  assert.match(page.card.style.transform, /rotateX\(-8deg\).*rotateY\(-8deg\)/);
  page.card.emit('pointerleave');
  assert.equal(page.card.style.transform, '');
  dispose();
});

test('所有卡片倾斜：触屏与减少动态效果不倾斜，设置改变时回正', () => {
  const page = scene({ reduced: true });
  const dispose = page.tilt();
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.equal(page.card.style.transform || '', '');
  page.media.matches = false;
  page.media.emit('change');
  page.card.emit('pointermove', { pointerType: 'touch', clientX: 320, clientY: 0 });
  assert.equal(page.card.style.transform || '', '');
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.match(page.card.style.transform || '', /rotateY\(8deg\)/);
  page.media.matches = true;
  page.media.emit('change');
  assert.equal(page.card.style.transform, '');
  dispose();
});

test('所有卡片倾斜：独立清理释放自己的事件，同时保留 Shader 悬停', () => {
  const page = scene();
  const disposeShader = page.mount();
  const disposeTilt = page.tilt();
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  disposeTilt();
  disposeTilt();
  assert.equal(page.card.style.transform, '');
  assert.equal(page.card.events.get('pointermove')?.size, 1);
  page.card.emit('pointerenter', { pointerType: 'mouse' });
  page.frame();
  assert.ok(page.calls.uniforms.uHover > 0.4);
  disposeShader();
  assert.equal(page.card.events.size, 0);
  assert.equal(page.media.events.size, 0);
});

test('用户 Shader 默认值：各排名使用独立默认颜色、浅色高光及预乘透明度', () => {
  const colors = [[109 / 255, 47 / 255, 1], [1, 74 / 255, 23 / 255], [15 / 255, 174 / 255, 122 / 255]];
  for (const rank of [1, 2, 3]) {
    const page = scene();
    const dispose = page.mount({}, rank);
    assert.equal(page.calls.contextOptions.premultipliedAlpha, true);
    for (const [key, value] of Object.entries({ uScale: 4, uBranch: 2, uVExt: 1.5, uHExt: 1.5, uRadius: 0.9, uPosY: 0 })) {
      assert.equal(page.calls.uniforms[key], value);
    }
    assert.deepEqual(page.calls.uniforms.uFlame, colors[rank - 1]);
    assert.deepEqual(page.calls.uniforms.uHi, colors[rank - 1].map((channel) => channel + (1 - channel) * 0.6));
    page.frame(1050);
    assert.equal(page.calls.uniforms.uTime, 0.05);
    dispose();
  }
});

test('用户 Shader 鼠标：平滑跟随卡片 UV、Y 翻转，离开后恢复自动摆动', () => {
  const page = scene();
  const dispose = page.mount();
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  page.frame(1016);
  assert.ok(Array.isArray(page.calls.uniforms.uMouse));
  assert.ok(page.calls.uniforms.uMouse[0] > 0.5 && page.calls.uniforms.uMouse[0] < 1);
  assert.ok(page.calls.uniforms.uMouse[1] > 0.35 && page.calls.uniforms.uMouse[1] < 1);
  for (let i = 2; i <= 80; i++) page.frame(1000 + i * 16);
  assert.ok(page.calls.uniforms.uMouse[0] > 0.98);
  assert.ok(page.calls.uniforms.uMouse[1] > 0.98);
  assert.ok(page.calls.uniforms.uHover > 0.98);
  page.card.emit('pointerleave');
  for (let i = 81; i <= 160; i++) page.frame(1000 + i * 16);
  assert.ok(page.calls.uniforms.uMouse[0] < 0.85);
  assert.ok(page.calls.uniforms.uMouse[1] < 0.55);
  assert.ok(Math.abs(page.calls.uniforms.uHover - 0.4) < 0.02);
  dispose();
});

test('用户 Shader 鼠标：触屏不拉动，后台暂停时间不累积', () => {
  const touch = scene();
  const control = scene();
  const disposeTouch = touch.mount();
  const disposeControl = control.mount();
  touch.card.emit('pointermove', { pointerType: 'touch', clientX: 320, clientY: 0 });
  touch.frame(1016);
  control.frame(1016);
  assert.deepEqual(touch.calls.uniforms.uMouse, control.calls.uniforms.uMouse);
  assert.equal(touch.calls.uniforms.uHover, 0.4);
  const time = touch.calls.uniforms.uTime;
  touch.document.hidden = true;
  touch.document.emit('visibilitychange');
  touch.frame(5000);
  assert.equal(touch.calls.uniforms.uTime, time);
  disposeTouch();
  disposeControl();
});

test('卡片参数：配置传入 uniform、颜色、画布透明度与动画速度', () => {
  const page = scene();
  const dispose = page.mount({ speed: 2, scale: 7, branch: 3, vext: 2, hext: 1, radius: 0.7, posy: -0.2,
    flame1: '#123456', opacity: 0.7, brightness: 1.3, highlight: 0.4, hoverStrength: 0.8 });
  for (const [key, value] of Object.entries({ uScale: 7, uBranch: 3, uVExt: 2, uHExt: 1, uRadius: 0.7, uPosY: -0.2,
    uBrightness: 1.3, uHighlight: 0.4, uHoverStrength: 0.8 })) assert.equal(page.calls.uniforms[key], value);
  assert.deepEqual(page.calls.uniforms.uFlame, [18 / 255, 52 / 255, 86 / 255]);
  assert.deepEqual(page.calls.uniforms.uHi, [18 / 255, 52 / 255, 86 / 255].map((channel) => channel + (1 - channel) * 0.6));
  assert.equal(page.canvas.style.opacity, '0.7');
  page.frame(1050);
  assert.equal(page.calls.uniforms.uTime, 0.2);
  dispose();
});

test('卡片参数：摆动角度可调整及关闭，减少动态与触屏仍生效', () => {
  const page = scene();
  const dispose = page.tilt({ tilt: 12 });
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.match(page.card.style.transform || '', /rotateX\(12deg\).*rotateY\(12deg\)/);
  dispose();
  const off = page.tilt({ tilt: 0 });
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.equal(page.card.style.transform, '');
  off();
});

test('卡片参数：连续更新不重建 WebGL，限幅与恢复默认即时生效', () => {
  const page = scene({ reduced: true });
  const dispose = page.mount();
  assert.equal(typeof dispose.update, 'function');
  const draws = page.calls.draws;
  dispose.update({ brightness: 99, opacity: -1, highlight: 0.5, hoverStrength: 0.7 });
  assert.equal(page.calls.uniforms.uBrightness, 1.5);
  assert.equal(page.calls.uniforms.uHighlight, 0.5);
  assert.equal(page.calls.uniforms.uHoverStrength, 0.7);
  assert.equal(page.canvas.style.opacity, '0');
  assert.ok(page.calls.draws > draws);
  dispose.update({ brightness: NaN, opacity: Infinity });
  assert.equal(page.calls.uniforms.uBrightness, 1);
  assert.equal(page.calls.uniforms.uHighlight, 1);
  assert.equal(page.canvas.style.opacity, '1');
  assert.equal(page.calls.contextsCreated, 1);
  dispose();
  const finalDraws = page.calls.draws;
  dispose.update({ brightness: 1.4 });
  assert.equal(page.calls.draws, finalDraws);
});

test('卡片参数：更新 tilt 为零立即回正，WebGL 降级仍可安全更新', () => {
  const page = scene();
  const dispose = page.tilt();
  assert.equal(typeof dispose.update, 'function');
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  dispose.update({ tilt: 0 });
  assert.equal(page.card.style.transform, '');
  dispose.update({ tilt: 50 });
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  assert.match(page.card.style.transform, /rotateX\(15deg\).*rotateY\(15deg\)/);
  dispose();
  for (const settings of [{ supported: false }, { compile: false }]) {
    const fallback = scene(settings).mount();
    assert.equal(typeof fallback.update, 'function');
    assert.doesNotThrow(() => { fallback.update({ opacity: 0.5 }); fallback(); });
  }
});

test('卡片颜色：运行中切换排名与修改指定颜色不重建 context，非法排名退 TOP 1', () => {
  const page = scene();
  const settings = { flame1: '#110000', flame2: '#002200', flame3: '#000033' };
  const dispose = page.mount(settings, 1);
  assert.deepEqual(page.calls.uniforms.uFlame, [17 / 255, 0, 0]);
  dispose.update(settings, 2);
  assert.deepEqual(page.calls.uniforms.uFlame, [0, 34 / 255, 0]);
  dispose.update({ ...settings, flame3: '#000066' });
  assert.deepEqual(page.calls.uniforms.uFlame, [0, 34 / 255, 0]);
  dispose.update({ ...settings, flame3: '#000066' }, 3);
  assert.deepEqual(page.calls.uniforms.uFlame, [0, 0, 102 / 255]);
  assert.deepEqual(page.calls.uniforms.uHi, [0, 0, 102 / 255].map((channel) => channel + (1 - channel) * 0.6));
  for (const rank of [0, 4, 1.5, '2', NaN]) {
    dispose.update(settings, rank);
    assert.deepEqual(page.calls.uniforms.uFlame, [17 / 255, 0, 0]);
  }
  assert.equal(page.calls.contextsCreated, 1);
  assert.deepEqual(settings, { flame1: '#110000', flame2: '#002200', flame3: '#000033' });
  dispose();
});

test('火焰消散：只按上升距离衰减透明度，默认零保留明亮效果', () => {
  const page = scene();
  const dispose = page.mount();
  assert.equal(page.calls.uniforms.uDecaySpeed, 0);
  const fragment = page.calls.shaderSources.find((source) => source.includes('gl_FragColor'));
  assert.match(fragment, /alpha\s*\*=\s*exp\(-uDecaySpeed\s*\*\s*max\(uv\.y-uPosY\*\.5,0\.\)\s*\/\s*uVExt\s*\*\s*3\.\)/);
  dispose();
});

test('火焰消散：实时更新不重建 WebGL，不改变流动时间、光标或颜色', () => {
  const page = scene();
  const settings = { speed: 0.75, decaySpeed: 0.5, flame1: '#123456' };
  const dispose = page.mount(settings);
  assert.equal(page.calls.uniforms.uDecaySpeed, 0.5);
  page.card.emit('pointermove', { pointerType: 'mouse', clientX: 320, clientY: 0 });
  page.frame(1050);
  const before = { time: page.calls.uniforms.uTime, hover: page.calls.uniforms.uHover,
    mouse: [...page.calls.uniforms.uMouse], flame: [...page.calls.uniforms.uFlame] };
  const draws = page.calls.draws;
  dispose.update({ ...settings, decaySpeed: 2.5 });
  assert.equal(page.calls.uniforms.uDecaySpeed, 2.5);
  assert.equal(page.calls.uniforms.uTime, before.time);
  assert.equal(page.calls.uniforms.uHover, before.hover);
  assert.deepEqual(page.calls.uniforms.uMouse, before.mouse);
  assert.deepEqual(page.calls.uniforms.uFlame, before.flame);
  assert.ok(page.calls.draws > draws);
  page.frame(1100);
  assert.equal(page.calls.uniforms.uTime, before.time + 0.05 * 0.75 * 2);
  dispose.update({ ...settings, decaySpeed: 0 });
  assert.equal(page.calls.uniforms.uDecaySpeed, 0);
  assert.equal(page.calls.contextsCreated, 1);
  dispose();
});
