const vertexSource = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_surface;
uniform sampler2D u_underwater;
uniform vec2 u_resolution;
uniform vec2 u_surfaceSize;
uniform vec2 u_underwaterSize;
uniform vec2 u_pointer;
uniform float u_progress;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
             mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), f.x), f.y);
}

float waterNoise(vec2 p) {
  return noise(p) * 0.57 + noise(p * 2.03 + 8.6) * 0.28 + noise(p * 4.01) * 0.15;
}

vec2 coverScale(vec2 imageSize) {
  float ratio = u_resolution.x / u_resolution.y;
  float imageRatio = imageSize.x / imageSize.y;
  return vec2(min(1.0, ratio / imageRatio), min(1.0, imageRatio / ratio));
}

vec3 photograph(sampler2D image, vec2 uv, vec2 imageSize) {
  vec2 imageUv = (uv - 0.5) * coverScale(imageSize) + 0.5;
  return texture2D(image, clamp(imageUv, vec2(0.001), vec2(0.999))).rgb;
}

float suspendedParticles(vec2 uv, float t, float depth) {
  vec2 position = uv * vec2(u_resolution.x / u_resolution.y, 1.0);
  float particles = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float z = float(layer);
    vec2 drift = position * (18.0 - z * 5.0);
    drift += vec2(t * (0.025 + z * 0.015), -t * (0.10 + z * 0.04) - depth * z * 0.7);
    vec2 cell = floor(drift);
    vec2 center = vec2(hash(cell + z * 19.0), hash(cell + 31.7 + z * 7.0));
    center = 0.2 + center * 0.6;
    center.x += sin(t * 0.65 + center.y * 12.0) * 0.06;
    float radius = 0.018 + z * 0.008;
    float mote = 1.0 - smoothstep(radius * 0.2, radius, length(fract(drift) - center));
    particles += mote * step(0.86, hash(cell + 74.3 + z * 11.0)) * (0.12 + z * 0.10);
  }
  return particles * smoothstep(0.0, 0.08, uv.y) * (1.0 - smoothstep(0.80, 1.0, uv.y));
}

void main() {
  vec2 uv = v_uv;
  float t = u_time;
  float p = clamp(u_progress, 0.0, 1.0);
  float aspect = u_resolution.x / u_resolution.y;
  float horizon = (0.33 - 0.5) / coverScale(u_surfaceSize).y + 0.5;
  float approach = smoothstep(0.0, 0.44, p);
  float entry = smoothstep(0.40, 0.58, p);
  float depth = smoothstep(0.58, 1.0, p);
  float lens = sin(entry * 3.14159265);
  vec2 lensWarp = vec2(waterNoise(uv * vec2(8.0 * aspect, 7.0) + t * 0.13),
                       waterNoise(uv * vec2(7.0 * aspect, 9.0) - t * 0.11)) - 0.5;
  lensWarp *= lens * 0.009;

  // The distant photograph remains nearly still; the close sea approaches the lens.
  vec2 skyUv = (uv - 0.5) / (1.0 + approach * 0.012) + 0.5;
  skyUv.y += approach * 0.006;
  skyUv += u_pointer * vec2(0.0007, 0.0004);
  skyUv += lensWarp;
  vec3 sky = photograph(u_surface, skyUv, u_surfaceSize);

  float nearDepth = clamp((horizon - uv.y) / max(horizon, 0.1), 0.0, 1.0);
  vec2 nearUv = vec2(0.5 + (uv.x - 0.5) / (1.0 + approach * 0.22),
                    horizon + (uv.y - horizon) / (1.0 + approach * 0.35));
  nearUv += lensWarp;
  vec2 seaUv = mix(skyUv, nearUv, pow(nearDepth, 1.15));

  // Broad, slow swell shifts photographic detail coherently rather than melting it.
  float swell = sin(uv.x * 4.4 + nearDepth * 2.4 - t * 0.72) * 0.65
              + sin(uv.x * 7.6 - nearDepth * 3.0 + t * 0.46) * 0.35;
  float waveAmplitude = min(32.0 / u_resolution.y, 0.040);
  float edgeRoom = smoothstep(0.0, 0.060, seaUv.y);
  float waveDepth = pow(nearDepth, 1.25) * edgeRoom;
  seaUv.y += swell * waveAmplitude * waveDepth;
  seaUv.x += sin(uv.x * 5.0 + nearDepth * 4.0 - t * 0.38) * 0.003 * waveDepth;
  seaUv.y += (waterNoise(vec2(uv.x * 15.0 * aspect, nearDepth * 18.0 - t * 0.4)) - 0.5)
           * 0.002 * waveDepth;
  seaUv += u_pointer * vec2(0.0022, 0.0011) * nearDepth;
  vec3 sea = photograph(u_surface, seaUv, u_surfaceSize);
  float seaMask = 1.0 - smoothstep(horizon - 0.0015, horizon + 0.0015, uv.y);
  vec3 surface = mix(sky, sea, seaMask);

  // The close water ceiling recedes faster than the distant blue as the camera descends.
  float ceiling = smoothstep(0.15, 0.95, uv.y);
  float underZoom = 1.0 + (1.0 - depth) * (0.035 + ceiling * 0.10);
  vec2 focus = vec2(0.76, 0.86);
  vec2 underUv = focus + (uv - focus) / underZoom;
  underUv.y -= depth * (1.0 - depth) * ceiling * 0.085;
  // Separate swells travel across the nearby ceiling even after scrolling stops.
  vec2 current = vec2(uv.x * aspect, uv.y);
  float waveA = current.x * 10.0 + current.y * 7.0 - t * 0.95;
  float waveB = current.x * -16.0 + current.y * 11.0 - t * 1.25;
  vec2 ripple = vec2(cos(waveA) + cos(waveB) * 0.38,
                     sin(waveA) * 0.65 + sin(waveB) * 0.35);
  float edgeFade = smoothstep(0.0, 0.05, uv.y) * (1.0 - smoothstep(0.96, 1.0, uv.y));
  underUv += ripple * vec2(0.014 / aspect, 0.012) * (0.12 + ceiling * 0.88) * edgeFade;
  underUv.x += (waterNoise(current * 13.0 + vec2(t * 0.40, -t * 0.28)) - 0.5) * 0.007 * ceiling / aspect;
  underUv.y += (waterNoise(current * 17.0 + vec2(-t * 0.30, t * 0.36)) - 0.5) * 0.006 * ceiling;
  underUv += u_pointer * vec2(0.0022, 0.0010) * (0.35 + ceiling * 0.65);
  underUv += lensWarp * 0.7;
  vec3 underwater = photograph(u_underwater, underUv, u_underwaterSize);
  underwater *= mix(vec3(1.0), vec3(0.90, 0.97, 1.0), depth * (1.0 - uv.y) * 0.55);

  // Moving light follows the photograph's sun, independently of the water texture.
  vec2 lightUv = (underUv - 0.5) * coverScale(u_underwaterSize) + 0.5;
  float rayAngle = (lightUv.x - 0.76) / max(0.18, 1.12 - lightUv.y);
  float rayNoise = waterNoise(vec2(rayAngle * 18.0 + t * 0.28, t * 0.36));
  float rays = smoothstep(0.42, 0.78, rayNoise);
  float lightDepth = smoothstep(0.02, 0.35, uv.y) * (1.0 - smoothstep(0.55, 0.92, uv.y));
  underwater *= 1.0 + ceiling * (sin(waveA + 0.7) + sin(waveB) * 0.4) * 0.045;
  underwater += vec3(0.16, 0.30, 0.33) * rays * lightDepth * 0.23;
  underwater += vec3(0.65, 0.86, 0.92) * suspendedParticles(uv, t, depth);

  // A short full-frame optical change avoids sweeping a horizontal panel over the view.
  vec3 color = mix(surface, underwater, entry);
  color *= 1.0 - lens * 0.055;
  gl_FragColor = vec4(color, 1.0);
}`;

export async function createOceanScene(canvas, options = {}) {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power', preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL is unavailable; the photographic fallback remains active.');

  const shaders = [];
  const textures = [];
  const program = gl.createProgram();
  let buffer;

  function dispose() {
    for (const texture of textures) gl.deleteTexture(texture);
    for (const shader of shaders) gl.deleteShader(shader);
    if (buffer) gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  }

  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = Object.fromEntries([
      'surface', 'underwater', 'resolution', 'surfaceSize', 'underwaterSize', 'pointer', 'progress', 'time',
    ].map(name => [name, gl.getUniformLocation(program, `u_${name}`)]));

    const images = await Promise.all(['surface.jpg', 'underwater.jpg'].map(name => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Could not load ocean background: ${name}`));
      image.src = new URL(`./assets/${name}`, import.meta.url).href;
    })));

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    images.forEach((image, index) => {
      const texture = gl.createTexture();
      textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    });
    gl.uniform1i(uniforms.surface, 0);
    gl.uniform1i(uniforms.underwater, 1);
    gl.uniform2f(uniforms.surfaceSize, images[0].naturalWidth, images[0].naturalHeight);
    gl.uniform2f(uniforms.underwaterSize, images[1].naturalWidth, images[1].naturalHeight);

    function resize() {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, width < 768 ? 1.25 : 1.6);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.resolution, width, height);
    }

    function render({ progress = 0, time = 0, pointerX = 0, pointerY = 0 } = {}) {
      gl.uniform1f(uniforms.progress, progress);
      gl.uniform1f(uniforms.time, time);
      gl.uniform2f(uniforms.pointer, pointerX, pointerY);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    resize();
    render();
    options.onReady?.();
    return { render, resize, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
