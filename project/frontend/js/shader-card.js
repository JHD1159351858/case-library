/* 使用用户提供的「Shader Card 复刻.html」片元与默认参数。 */
import { normalizeCardEffectSettings } from './card-effect-settings.js';

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uHover;
uniform vec3 uFlame; uniform vec3 uHi;
uniform float uScale, uBranch, uVExt, uHExt, uRadius, uPosY;
uniform float uBrightness, uHighlight, uHoverStrength, uDecaySpeed;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<5;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes; float asp=uRes.x/uRes.y; float t=uTime;
  vec2 p=vec2((uv.x-.5)*asp,uv.y-uPosY*.5);
  vec2 q=p*uScale*.55;
  // 域扭曲：两层噪声先把坐标扭一遍，得到烟雾般的翻卷形态；整体向下采样 = 火焰向上升
  vec2 w=vec2(fbm(q+vec2(0.,-t*.35)),fbm(q+vec2(5.2,1.3)+vec2(0.,-t*.3)));
  float n=fbm(q*1.3+w*1.8+vec2(0.,-t*.5));
  // 包络：底部最强，越往上越弱；左右用 Horizontal Extent 收边
  float ex=abs(uv.x-.5)*2.;
  float horiz=clamp(1.-pow(ex/uHExt,2.5),0.,1.);
  float vert=clamp(1.-(uv.y-uPosY*.5)/uVExt,0.,1.);
  // 鼠标：高斯凸起，把火焰“拉”向光标
  float d=length((uv-uMouse)*vec2(asp,1.));
  float bump=exp(-d*d/(uRadius*uRadius*.16))*uHoverStrength*uHover;
  float field=n+.95*vert*horiz-.58+bump;
  float a=smoothstep(.40,.80,field);           // 火焰主体（边缘虚化）
  float core=smoothstep(.55,1.15,field);        // 内核
  float haze=smoothstep(.15,.7,field)*.28;      // 外圈辉光
  // 细脉络：脊状噪声 -> 闪电般的亮线
  float rg=1.-abs(2.*fbm(q*1.8+w*1.2+vec2(3.1,-t*.25))-1.);
  float veins=pow(rg,14.)*uBranch*.38*smoothstep(.2,.7,field);
  vec3 col=mix(uFlame*.5,uFlame,a);
  col=mix(col,uHi,core*.65);
  col+=uFlame*pow(1.-uv.y,3.)*.55;              // 底边泛光
  col+=mix(uHi,vec3(1.),.5)*veins;
  float alpha=clamp(a*.96+haze+veins*.5,0.,1.);
  alpha*=exp(-uDecaySpeed*max(uv.y-uPosY*.5,0.)/uVExt*3.);
  col+= (hash(gl_FragCoord.xy+t)-.5)/255.;       // 抖动，防色带
  col=mix(uFlame,col,uHighlight)*uBrightness;
  gl_FragColor=vec4(col*alpha,alpha);
}
`;

function readCardBounds(card) {
  const parent = card.offsetParent;
  if (!parent) return card.getBoundingClientRect();
  const origin = parent.getBoundingClientRect();
  return {
    left: origin.left + parent.clientLeft + card.offsetLeft - parent.scrollLeft,
    top: origin.top + parent.clientTop + card.offsetTop - parent.scrollTop,
    width: card.offsetWidth, height: card.offsetHeight
  };
}

/** 所有卡片共用；返回 dispose，并支持 dispose.update(settings) 即时调整。 */
export function mountCardTilt(card, settings = {}) {
  let effectSettings = normalizeCardEffectSettings(settings);
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let bounds = null;
  let disposed = false;
  function enter(event) {
    if (!media.matches && event.pointerType === 'mouse') bounds = readCardBounds(card);
  }
  function move(event) {
    if (media.matches || event.pointerType !== 'mouse' || effectSettings.tilt === 0) return;
    if (!bounds) bounds = readCardBounds(card);
    const x = Math.max(-0.5, Math.min(0.5, (event.clientX - bounds.left) / bounds.width - 0.5));
    const y = Math.max(-0.5, Math.min(0.5, (event.clientY - bounds.top) / bounds.height - 0.5));
    card.style.transform = `perspective(900px) rotateX(${-y * effectSettings.tilt * 2}deg) rotateY(${x * effectSettings.tilt * 2}deg) translate3d(${x * 3}px, ${y * 2 - 4}px, 0)`;
  }
  function reset() {
    bounds = null;
    card.style.transform = '';
  }
  card.addEventListener('pointerenter', enter);
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerleave', reset);
  media.addEventListener('change', reset);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    card.removeEventListener('pointerenter', enter);
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerleave', reset);
    media.removeEventListener('change', reset);
    reset();
  };
  dispose.update = (nextSettings) => {
    if (disposed) return;
    effectSettings = normalizeCardEffectSettings(nextSettings);
    if (effectSettings.tilt === 0) reset();
  };
  return dispose;
}

/** 热门装饰；dispose.update(settings, rank) 可更新颜色和排名，不重建 WebGL。 */
export function mountShaderCard(card, settings = {}, rank = 1) {
  let effectSettings = normalizeCardEffectSettings(settings);
  const canvas = document.createElement('canvas');
  canvas.className = 'shader-card-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.pointerEvents = 'none';
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return Object.assign(() => {}, { update() {} });

  const shaders = [];
  let program;
  let buffer;
  function releaseGraphics() {
    shaders.forEach((shader) => gl.deleteShader(shader));
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compile failed');
    }
    program = gl.createProgram();
    shaders.forEach((shader) => gl.attachShader(program, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed');
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  } catch {
    releaseGraphics();
    return Object.assign(() => {}, { update() {} });
  }

  const uniformNames = { res: 'uRes', time: 'uTime', mouse: 'uMouse', hover: 'uHover', flame: 'uFlame', hi: 'uHi',
    scale: 'uScale', branch: 'uBranch', vext: 'uVExt', hext: 'uHExt', radius: 'uRadius', posy: 'uPosY',
    brightness: 'uBrightness', highlight: 'uHighlight', hoverStrength: 'uHoverStrength', decaySpeed: 'uDecaySpeed' };
  const uniforms = Object.fromEntries(Object.entries(uniformNames).map(([key, name]) => [key, gl.getUniformLocation(program, name)]));
  function applySettings(nextSettings, nextRank = rank) {
    effectSettings = normalizeCardEffectSettings(nextSettings);
    rank = [1, 2, 3].includes(nextRank) ? nextRank : 1;
    canvas.style.opacity = String(effectSettings.opacity);
    const color = effectSettings[`flame${rank}`];
    const flame = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
    gl.uniform3fv(uniforms.flame, flame);
    gl.uniform3fv(uniforms.hi, flame.map((channel) => channel + (1 - channel) * 0.6));
    for (const key of ['scale', 'branch', 'vext', 'hext', 'radius', 'posy', 'brightness', 'highlight', 'hoverStrength', 'decaySpeed']) {
      gl.uniform1f(uniforms[key], effectSettings[key]);
    }
  }
  applySettings(effectSettings);
  gl.clearColor(0, 0, 0, 0);
  card.appendChild(canvas);

  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let disposed = false;
  let frame = 0;
  let hover = 0.4;
  let hoverTarget = 0.4;
  let inside = false;
  let pointerBounds = null;
  let time = 0;
  let lastFrame = performance.now();
  const mouse = { x: 0.5, y: 0.35, tx: 0.5, ty: 0.35 };
  function draw() {
    gl.uniform1f(uniforms.time, time);
    gl.uniform2f(uniforms.mouse, mouse.x, mouse.y);
    gl.uniform1f(uniforms.hover, hover);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  function animate(now) {
    frame = 0;
    if (disposed || !visible || document.hidden || media.matches) return;
    const dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    time += dt * effectSettings.speed * 2;
    if (!inside) {
      mouse.tx = 0.5 + 0.3 * Math.sin(time * 0.4);
      mouse.ty = 0.35 + 0.12 * Math.cos(time * 0.3);
    }
    const ease = 1 - Math.pow(0.001, dt);
    mouse.x += (mouse.tx - mouse.x) * ease * 0.55;
    mouse.y += (mouse.ty - mouse.y) * ease * 0.55;
    hover += (hoverTarget - hover) * ease * 0.5;
    draw();
    frame = requestAnimationFrame(animate);
  }
  function syncAnimation() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (disposed) return;
    if (media.matches) {
      hover = hoverTarget = 0.4;
      inside = false;
      pointerBounds = null;
      mouse.x = mouse.tx = 0.5;
      mouse.y = mouse.ty = 0.35;
      if (visible && !document.hidden) draw();
    } else if (visible && !document.hidden) {
      lastFrame = performance.now();
      frame = requestAnimationFrame(animate);
    }
  }
  function resize() {
    if (disposed) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(card.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(card.clientHeight * ratio));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.res, canvas.width, canvas.height);
    if (visible && !document.hidden) draw();
  }
  function enter(event) {
    if (media.matches || event.pointerType !== 'mouse') return;
    pointerBounds = readCardBounds(card);
    inside = true;
    hoverTarget = 1;
  }
  function move(event) {
    if (media.matches || event.pointerType !== 'mouse') return;
    if (!inside) enter(event);
    mouse.tx = Math.max(-0.1, Math.min(1.1, (event.clientX - pointerBounds.left) / pointerBounds.width));
    mouse.ty = Math.max(-0.1, Math.min(1.1, 1 - (event.clientY - pointerBounds.top) / pointerBounds.height));
  }
  function leave() {
    inside = false;
    pointerBounds = null;
    hoverTarget = 0.4;
  }
  const resizeObserver = new ResizeObserver(resize);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncAnimation();
  });
  resizeObserver.observe(canvas);
  intersectionObserver.observe(card);
  card.addEventListener('pointerenter', enter);
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerleave', leave);
  document.addEventListener('visibilitychange', syncAnimation);
  media.addEventListener('change', syncAnimation);
  resize();
  syncAnimation();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    card.removeEventListener('pointerenter', enter);
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerleave', leave);
    document.removeEventListener('visibilitychange', syncAnimation);
    media.removeEventListener('change', syncAnimation);
    leave();
    releaseGraphics();
    canvas.remove();
  };
  dispose.update = (nextSettings, nextRank = rank) => {
    if (disposed) return;
    applySettings(nextSettings, nextRank);
    if (visible && !document.hidden) draw();
  };
  return dispose;
}
