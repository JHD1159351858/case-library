import { AGX_TRANSFORM } from './post.js';

// Recover scene radiance once, so the existing HDR/post pipeline does not tone-map
// a display-referred sky twice. Parameters match the shared composite look.
export const SKY_PHOTO_LINEARIZE = AGX_TRANSFORM + /* wgsl */ `
struct PhotoP { look: vec4f }; // exposure, saturation, contrast, warmth
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> P: PhotoP;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let inset = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let displayed = textureLoad(source, vec2i(id.xy), 0).rgb;
  let desired = clamp(inset * displayed, vec3f(0.002), vec3f(0.985));
  var contrast = desired;
  for (var i = 0; i < 4; i++) {
    let lum = dot(contrast, vec3f(0.2126, 0.7152, 0.0722));
    contrast = pow(max((desired + (P.look.y - 1.0) * lum) / P.look.y, vec3f(0.0)), vec3f(1.0 / P.look.z));
  }
  var lo = vec3f(0.0);
  var hi = vec3f(1.0);
  for (var i = 0; i < 14; i++) {
    let mid = (lo + hi) * 0.5;
    let below = agxContrast(mid) < contrast;
    lo = select(lo, mid, below);
    hi = select(mid, hi, below);
  }
  var radiance = agxEotf(exp2(mix(vec3f(-12.47393), vec3f(4.026069), (lo + hi) * 0.5)));
  let lum = dot(radiance, vec3f(0.2126, 0.7152, 0.0722));
  let desaturation = smoothstep(0.7, 6.0, lum) * 0.55;
  radiance = (radiance - lum * desaturation) / (1.0 - desaturation);
  radiance /= P.look.x * vec3f(1.0 + P.look.w, 1.0, 1.0 - P.look.w);
  textureStore(destination, id.xy, vec4f(max(radiance, vec3f(0.0)), 1.0));
}
`;

// A perspective patch in world directions, shared by the visible sky and its
// reflections. The horizon is the image's bottom edge; it contains no ocean.
// Requires skyPhoto and sampC. Outside the patch its weight reaches zero before
// clamped texture samples can stretch into streaks around the hemisphere.
export const SKY_PHOTO_PROJECTION = /* wgsl */ `
fn photographSky(direction: vec3f) -> vec4f {
  let forward = max(-direction.z, 0.0001);
  let uv = vec2f(0.5 + direction.x / (2.2 * forward), 1.0 - direction.y / (0.75 * forward));
  let sides = smoothstep(0.0, 0.065, uv.x) * (1.0 - smoothstep(0.935, 1.0, uv.x));
  let top = smoothstep(0.0, 0.10, uv.y);
  let bottom = 1.0 - smoothstep(1.0, 1.025, uv.y);
  let weight = sides * top * bottom * smoothstep(0.02, 0.15, -direction.z);
  let radiance = textureSampleLevel(skyPhoto, sampC, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  return vec4f(radiance, weight);
}
`;
