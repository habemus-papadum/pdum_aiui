/**
 * shaders.ts — GLSL for the Gray-Scott reaction-diffusion system.
 *
 * Two chemicals U and V live in the R and G channels of a ping-ponged float
 * texture. Each step applies (Karl Sims' parameterization, dt = 1):
 *
 *   U' = U + Du·∇²U − U·V² + F·(1 − U)
 *   V' = V + Dv·∇²V + U·V² − (F + k)·V
 *
 * F ("feed") replenishes U; k ("kill") removes V. The (F, k) plane is the
 * Pearson (1993) regime map the atlas panel shows: spots, stripes, mitosis,
 * solitons, chaos — Turing's morphogenesis in two knobs.
 *
 * This module is pure data (strings). It is deliberately separate from the
 * engine so a shader edit is a *disposable-logic* HMR event: the engine
 * recompiles its programs in place and the field texture — the durable state
 * — is untouched (see gray-scott.ts hot handling in main.tsx).
 */

export const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
const vec2 corners[4] = vec2[4](vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.), vec2(1.,1.));
out vec2 vUv;
void main() {
  vec2 p = corners[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0., 1.);
}`;

export const STEP_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uField;   // R = U, G = V
uniform vec2 uTexel;        // 1 / size
uniform float uF;           // feed
uniform float uK;           // kill
uniform float uDu;          // diffusion of U
uniform float uDv;          // diffusion of V
uniform vec3 uBrush;        // x, y in uv; z = radius in uv (0 = inactive)
in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 c = texture(uField, vUv).rg;

  // 9-point Laplacian, weights: center -1, orthogonal 0.2, diagonal 0.05.
  vec2 lap = -c;
  lap += 0.2  * texture(uField, vUv + vec2( uTexel.x, 0.)).rg;
  lap += 0.2  * texture(uField, vUv + vec2(-uTexel.x, 0.)).rg;
  lap += 0.2  * texture(uField, vUv + vec2(0.,  uTexel.y)).rg;
  lap += 0.2  * texture(uField, vUv + vec2(0., -uTexel.y)).rg;
  lap += 0.05 * texture(uField, vUv + vec2( uTexel.x,  uTexel.y)).rg;
  lap += 0.05 * texture(uField, vUv + vec2(-uTexel.x,  uTexel.y)).rg;
  lap += 0.05 * texture(uField, vUv + vec2( uTexel.x, -uTexel.y)).rg;
  lap += 0.05 * texture(uField, vUv + vec2(-uTexel.x, -uTexel.y)).rg;

  float u = c.r;
  float v = c.g;
  float uvv = u * v * v;
  float du = uDu * lap.r - uvv + uF * (1.0 - u);
  float dv = uDv * lap.g + uvv - (uF + uK) * v;
  u = clamp(u + du, 0.0, 1.0);
  v = clamp(v + dv, 0.0, 1.0);

  // Pointer painting: inject V in a soft disc around the brush.
  if (uBrush.z > 0.0) {
    float d = distance(vUv, uBrush.xy);
    v = max(v, 0.9 * exp(-(d * d) / (uBrush.z * uBrush.z)));
  }

  outColor = vec4(u, v, 0.0, 1.0);
}`;

export const DISPLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uField;
in vec2 vUv;
out vec4 outColor;

// Map the pattern (U − V is the classic contrast) through a dark scientific
// palette: deep indigo substrate → teal → pale membrane highlights.
void main() {
  vec2 c = texture(uField, vUv).rg;
  float t = clamp(1.0 - (c.r - c.g), 0.0, 1.0);  // 0 = pure U, 1 = strong V
  vec3 deep   = vec3(0.055, 0.066, 0.100);   // page background
  vec3 mid    = vec3(0.079, 0.271, 0.339);   // deep teal
  vec3 bright = vec3(0.322, 0.760, 0.702);   // pattern body
  vec3 rim    = vec3(0.878, 0.965, 0.910);   // membrane highlight
  vec3 color = deep;
  color = mix(color, mid,    smoothstep(0.05, 0.45, t));
  color = mix(color, bright, smoothstep(0.45, 0.75, t));
  color = mix(color, rim,    smoothstep(0.80, 0.98, t));
  outColor = vec4(color, 1.0);
}`;

/** Pack U,V into bytes for readback (R = U·255, G = V·255). */
export const ENCODE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uField;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 c = texture(uField, vUv).rg;
  outColor = vec4(c, 0.0, 1.0);
}`;
