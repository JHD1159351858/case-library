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

vec3 wave(vec2 point, vec2 direction, float frequency, float amplitude, float speed, float time) {
  float phase = dot(point, direction) * frequency - time * speed;
  float height = sin(phase) * amplitude;
  vec2 slope = cos(phase) * amplitude * frequency * direction;
  return vec3(height, slope);
}

vec3 oceanField(vec2 point, float time) {
  // World-space swells travel in different directions; y/z hold analytic slopes.
  vec3 field = wave(point, vec2(0.26, 0.966), 1.35, 0.145, 1.20, time);
  field += wave(point, vec2(-0.45, 0.893), 2.20, 0.075, 1.67, time);
  field += wave(point, vec2(0.78, 0.626), 3.80, 0.037, 2.05, time);
  field += wave(point, vec2(-0.82, 0.572), 6.70, 0.016, 2.68, time);
  field += wave(point, vec2(0.52, 0.854), 12.5, 0.006, 3.35, time);
  field += wave(point, vec2(-0.22, 0.975), 21.0, 0.003, 4.12, time);
  return field;
}

void main() {
  vec2 uv = v_uv;
  float t = u_time;
  float p = clamp(u_progress, 0.0, 1.0);
  float aspect = u_resolution.x / u_resolution.y;
  float horizon = (0.33 - 0.5) / coverScale(u_surfaceSize).y + 0.5;
  float foreground = clamp((horizon - uv.y) / max(horizon, 0.05), 0.0, 1.0);
  float descent = smoothstep(0.10, 0.86, p);
  float lineHeight = mix(-0.12, 1.14, descent);
  float lineWave = (waterNoise(vec2(uv.x * 8.0, t * 0.27)) - 0.5) * 0.065;
  lineWave += sin(uv.x * 13.0 + t * 0.63) * 0.008;
  float distanceToLine = lineHeight + lineWave - uv.y;
  float lineWidth = 3.0 / u_resolution.y;
  float submerged = smoothstep(-lineWidth, lineWidth, distanceToLine);
  float crossing = smoothstep(0.12, 0.23, p) * (1.0 - smoothstep(0.77, 0.90, p));
  float meniscus = exp(-pow(distanceToLine / (lineWidth * 2.5), 2.0)) * crossing;

  // Project a moving height field into the photographed sea, keeping its real detail.
  vec2 surfaceUv = (uv - 0.5) / (1.0 + p * 0.045) + 0.5;
  float belowHorizon = max(0.0, horizon - uv.y);
  float waveWeight = smoothstep(0.0, 0.035, belowHorizon);
  vec2 seaPoint = vec2((uv.x - 0.5) * aspect, 1.0) / max(0.045, belowHorizon);
  vec3 field = oceanField(seaPoint, t);
  float swellProjection = field.x * belowHorizon * 0.34;
  float ripple = noise(seaPoint * 13.0 + vec2(t * 0.32, -t * 0.60)) - 0.5;
  surfaceUv.y += (swellProjection + ripple * 0.004 * foreground) * waveWeight;
  surfaceUv.x += field.y * 0.021 * foreground * waveWeight;
  surfaceUv += u_pointer * vec2(0.0015, 0.0008);
  surfaceUv += vec2(sin(uv.x * 28.0 + t * 0.8) * 0.0018, 0.0015) * meniscus;

  // Two staggered flow phases feed new photographed crests toward the camera.
  // Each phase resets only while invisible, so the 6.8 s cycle has no jump.
  float flowA = fract(t / 6.8);
  float flowB = fract(t / 6.8 + 0.5);
  float flowWeight = 0.5 - 0.5 * cos(flowA * 6.2831853);
  float flowDepth = pow(foreground, 1.45) * waveWeight;
  vec2 flow = vec2(field.y * 0.018, 0.085) * flowDepth;
  vec3 surface = mix(photograph(u_surface, surfaceUv + flow * flowB, u_surfaceSize),
                     photograph(u_surface, surfaceUv + flow * flowA, u_surfaceSize), flowWeight);
  vec3 normal = normalize(vec3(-field.y * 0.72, 1.0, -field.z * 0.72));
  vec3 view = normalize(vec3((0.5 - uv.x) * aspect * 0.9, 0.15 + foreground * 0.42, -1.3));
  vec3 sun = normalize(vec3(0.26 * aspect * 0.9, 0.12, 1.3));
  vec3 halfway = normalize(view + sun);
  float fresnel = pow(1.0 - max(0.0, dot(normal, view)), 4.0);
  vec2 reflectionUv = vec2(uv.x + normal.x * 0.14,
                           horizon + 0.12 + abs(normal.z) * 0.38);
  vec3 reflectedSky = photograph(u_surface, reflectionUv, u_surfaceSize);
  vec3 movingSea = surface * (0.91 + normal.z * 0.23 + normal.y * 0.07);
  movingSea = mix(movingSea, reflectedSky, (0.07 + fresnel * 0.12) * foreground);
  float sunPath = exp(-pow((uv.x - 0.76) / (0.045 + foreground * 0.19), 2.0));
  float glint = pow(max(0.0, dot(normal, halfway)), 68.0);
  float broadReflection = pow(max(0.0, dot(normal, halfway)), 15.0);
  movingSea += vec3(1.0, 0.79, 0.46) * sunPath
             * (glint * 0.48 + broadReflection * 0.075) * (0.28 + foreground * 0.72);
  surface = mix(surface, movingSea, waveWeight);

  // Reveal the underwater view gradually after the lens crosses the surface.
  float underZoom = 1.025 + p * 0.065;
  vec2 underUv = (uv - 0.5) / underZoom + 0.5;
  underUv.y += p * 0.024;
  vec2 current = vec2(uv.x * 5.0 * aspect, uv.y * 6.0);
  underUv.x += (waterNoise(current + vec2(t * 0.10, -t * 0.09)) - 0.5) * 0.008;
  underUv.y += (waterNoise(current * 1.35 + vec2(-t * 0.08, t * 0.14)) - 0.5) * 0.006;
  underUv += u_pointer * vec2(0.0025, 0.0012);
  underUv.x += sin(uv.x * 22.0 + t * 0.55) * meniscus * 0.002;
  underUv.y += meniscus * 0.002;
  vec3 underwater = photograph(u_underwater, underUv, u_underwaterSize);

  float rayX = (uv.x - 0.77) / (1.1 - uv.y * 0.65);
  float ray = pow(max(0.0, sin(rayX * 48.0 + t * 0.16)
                      * sin(rayX * 23.0 - t * 0.09)), 6.0);
  ray *= (1.0 - uv.y) * 0.018;
  underwater += vec3(0.56, 0.78, 0.75) * ray;
  underwater *= mix(vec3(1.0), vec3(0.84, 0.94, 0.98), p * (1.0 - uv.y));

  // Sparse particles drift independently of the reversible scroll position.
  vec2 particleUv = vec2(uv.x * aspect, uv.y) * 11.0;
  particleUv.y -= t * 0.065;
  vec2 cell = floor(particleUv);
  vec2 local = fract(particleUv);
  float seed = hash(cell);
  vec2 position = vec2(0.15 + hash(cell + 1.7) * 0.7, 0.15 + hash(cell + 8.1) * 0.7);
  float particle = (1.0 - smoothstep(0.012, 0.046, length(local - position)))
                 * step(0.87, seed) * 0.18;
  underwater += vec3(0.65, 0.86, 0.91) * particle;

  // The same sea detail continues through the waterline before fading into depth.
  float waterDepth = max(0.0, distanceToLine);
  float surfaceShift = max(0.0, lineHeight + lineWave - horizon + 0.012);
  vec2 throughUv = surfaceUv - vec2(0.0, surfaceShift);
  vec3 throughWater = mix(surface, photograph(u_surface, throughUv, u_surfaceSize),
                          smoothstep(0.0, 0.025, surfaceShift));
  throughWater *= mix(vec3(1.0), vec3(0.48, 0.78, 0.91), smoothstep(0.0, 0.30, waterDepth));
  float reveal = smoothstep(0.02, 0.25, waterDepth) * smoothstep(0.30, 0.74, p);
  reveal = mix(reveal, 1.0, smoothstep(0.78, 0.94, p));
  vec3 immersed = mix(throughWater, underwater, reveal);
  vec3 color = mix(surface, immersed, submerged);
  color *= mix(vec3(1.0), vec3(0.90, 0.97, 1.0), meniscus * 0.18);
  color += vec3(0.38, 0.55, 0.53) * meniscus * 0.02;
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
