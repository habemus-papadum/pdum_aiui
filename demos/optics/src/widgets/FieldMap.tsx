/**
 * FieldMap.tsx — the 2-D wave picture, live: a WebGL2 island that renders a
 * complex field E(x, z) either as the *traveling wave* (Re E·e^{-iωt},
 * animated — the thing that is really there) or as the *time-averaged
 * intensity* (|E|² — the only thing film or an eye can see). That toggle IS
 * the central lesson of the holography notebook, so it lives in the widget.
 *
 * Orientation: light travels left → right (+z); x is vertical (up = +x).
 * `overlay` children are SVG drawn in WORLD coordinates (z, x) — the widget
 * wraps them in the y-flip so consumers write plain (z, x) pairs; use
 * `vector-effect="non-scaling-stroke"` on strokes.
 *
 * Imperative-island rules per the frontend playbook: the rAF loop never reads
 * signals; data/props arrive through two-arg createEffect bridges; the loop
 * parks itself whenever the element is off screen (anim.ts).
 */

import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, untrack } from "solid-js";
import type { FieldMapData } from "../mapwork";
import { whileVisible } from "./anim";

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = (aPos + 1.0) * 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform int uMode;      // 0 = wave, 1 = intensity, 2 = rgb intensity
uniform float uT;       // temporal phase, radians
uniform float uAmp;     // amplitude display gain
uniform float uInt;     // intensity display gain
uniform vec3 uTint;
uniform vec3 uNeg;
out vec4 frag;
void main() {
  // texture: width axis = x (screen-vertical), height axis = z (screen-horizontal)
  vec2 tuv = vec2(vUv.y, vUv.x);
  vec4 s = texture(uTex, tuv);
  if (uMode == 2) {
    frag = vec4(vec3(1.0) - exp(-s.rgb * uInt), 1.0);
  } else if (uMode == 1) {
    float I = dot(s.rg, s.rg) * uInt;
    frag = vec4(uTint * (1.0 - exp(-I)), 1.0);
  } else {
    float a = (s.r * cos(uT) + s.g * sin(uT)) * uAmp;
    a = a / (1.0 + 0.35 * abs(a)); // soft clip
    frag = vec4(uTint * max(a, 0.0) + uNeg * max(-a, 0.0), 1.0);
  }
}`;

interface Gl {
  gl: WebGL2RenderingContext;
  uT: WebGLUniformLocation | null;
  uMode: WebGLUniformLocation | null;
  uAmp: WebGLUniformLocation | null;
  uInt: WebGLUniformLocation | null;
  uTint: WebGLUniformLocation | null;
  uNeg: WebGLUniformLocation | null;
}

function initGl(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) return null;
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("shader alloc failed");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
    }
    return sh;
  };
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = gl.getExtension("OES_texture_float_linear") ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    gl,
    uT: gl.getUniformLocation(prog, "uT"),
    uMode: gl.getUniformLocation(prog, "uMode"),
    uAmp: gl.getUniformLocation(prog, "uAmp"),
    uInt: gl.getUniformLocation(prog, "uInt"),
    uTint: gl.getUniformLocation(prog, "uTint"),
    uNeg: gl.getUniformLocation(prog, "uNeg"),
  };
}

/** Display normalization from the buffer's non-empty texels. */
function stats(data: FieldMapData): { amp: number; int: number } {
  let sum = 0;
  let count = 0;
  if (data.kind === "coherent") {
    for (let i = 0; i < data.re.length; i += 7) {
      const p = data.re[i] * data.re[i] + data.im[i] * data.im[i];
      if (p > 0) {
        sum += p;
        count++;
      }
    }
  } else {
    for (let i = 0; i < data.rgb.length; i += 3) {
      const p = data.rgb[i] + data.rgb[i + 1] + data.rgb[i + 2];
      if (p > 0) {
        sum += p;
        count++;
      }
    }
  }
  const mean = count > 0 ? sum / count : 1;
  return { amp: 1 / Math.sqrt(mean * 2.2), int: 1.1 / (mean || 1) };
}

export function FieldMap(props: {
  data: FieldMapData;
  /** Coherent maps: the live wave, or what a detector sees. Default "wave". */
  view?: "wave" | "intensity";
  /** Temporal cycles per second in wave view. Default 0.7. */
  speed?: number;
  /** Extra display gain (×). Default 1. */
  gain?: number;
  /** CSS aspect ratio (width/height) of the stage. Default 16/9. */
  aspect?: number;
  /** SVG overlay in world (z, x) coordinates. */
  overlay?: JSX.Element;
  /** Pointer press/drag position in world coordinates. */
  onProbe?: (p: { x: number; z: number }) => void;
  class?: string;
}) {
  let holder!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let ctx: Gl | null = null;
  let phase = 0;
  let lastT = 0;
  let mode = 0;
  let amp = 1;
  let int = 1;
  let tint: [number, number, number] = [1, 1, 1];
  let stopAnim: (() => void) | undefined;
  let ro: ResizeObserver | undefined;

  onCleanup(() => {
    stopAnim?.();
    ro?.disconnect();
    ctx?.gl.getExtension("WEBGL_lose_context")?.loseContext();
    ctx = null;
  });

  const draw = (): void => {
    if (!ctx) return;
    const { gl } = ctx;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(ctx.uT, phase);
    gl.uniform1i(ctx.uMode, mode);
    gl.uniform1f(ctx.uAmp, amp);
    gl.uniform1f(ctx.uInt, int);
    gl.uniform3f(ctx.uTint, tint[0], tint[1], tint[2]);
    // complement color for the wave's negative half-cycles
    gl.uniform3f(
      ctx.uNeg,
      0.1 + 0.5 * (1 - tint[0]),
      0.1 + 0.5 * (1 - tint[1]),
      0.1 + 0.5 * (1 - tint[2]),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const upload = (data: FieldMapData | undefined): void => {
    if (!ctx || !data) return;
    const { gl } = ctx;
    const texels = data.nx * data.nz;
    const packed = new Float32Array(texels * 4);
    if (data.kind === "coherent") {
      for (let i = 0; i < texels; i++) {
        packed[i * 4] = data.re[i];
        packed[i * 4 + 1] = data.im[i];
      }
      tint = [data.tint[0], data.tint[1], data.tint[2]];
    } else {
      for (let i = 0; i < texels; i++) {
        packed[i * 4] = data.rgb[i * 3];
        packed[i * 4 + 1] = data.rgb[i * 3 + 1];
        packed[i * 4 + 2] = data.rgb[i * 3 + 2];
      }
    }
    // width = nx (x axis), height = nz (z axis) — matches the [iz·nx + ix] layout
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, data.nx, data.nz, 0, gl.RGBA, gl.FLOAT, packed);
    const s = stats(data);
    amp = s.amp * gainV;
    int = s.int * gainV;
    draw();
  };

  const fitCanvas = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(holder.clientWidth * dpr));
    const h = Math.max(1, Math.round(holder.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      draw();
    }
  };

  // Init hangs off the CANVAS ref: refs fire in document order, so the outer
  // div's ref would run before `canvas` was assigned. The cloned template is a
  // complete tree, so the parent is already reachable here.
  const setup = (el: HTMLCanvasElement): void => {
    canvas = el;
    holder = el.parentElement as HTMLDivElement;
    ctx = initGl(canvas);
    ro = new ResizeObserver(fitCanvas);
    ro.observe(holder);
    stopAnim = whileVisible(holder, (t) => {
      if (mode === 0) {
        const dt = lastT ? (t - lastT) / 1000 : 0;
        phase += 2 * Math.PI * speedV * dt;
        draw();
      }
      lastT = t;
    });
    upload(untrack(() => props.data));
    fitCanvas();
  };

  // reactive bridges into the island (two-arg createEffect; handlers consume
  // the computed value, the rAF loop reads only these mirrored lets)
  let speedV = 0.7;
  let gainV = 1;
  createEffect(
    () => props.data,
    (d) => upload(d),
  );
  createEffect(
    () => ({
      view: props.view ?? "wave",
      gain: props.gain ?? 1,
      kind: props.data?.kind,
      speed: props.speed ?? 0.7,
    }),
    (v) => {
      speedV = v.speed;
      gainV = v.gain;
      mode = v.kind === "rgb" ? 2 : v.view === "intensity" ? 1 : 0;
      const d = untrack(() => props.data);
      if (d) {
        const s = stats(d);
        amp = s.amp * v.gain;
        int = s.int * v.gain;
      }
      draw();
    },
  );

  const world = (ev: PointerEvent): { x: number; z: number } | null => {
    const d = props.data;
    if (!d) return null;
    const r = canvas.getBoundingClientRect();
    const z = d.z0 + ((ev.clientX - r.left) / r.width) * (d.z1 - d.z0);
    const x = d.x1 - ((ev.clientY - r.top) / r.height) * (d.x1 - d.x0);
    return { x, z };
  };
  let dragging = false;

  const viewBox = () => {
    const d = props.data;
    return d ? `${d.z0} ${-d.x1} ${d.z1 - d.z0} ${d.x1 - d.x0}` : "0 0 1 1";
  };

  return (
    <div
      class={props.class ? `optix-map ${props.class}` : "optix-map"}
      style={{ "aspect-ratio": String(props.aspect ?? 16 / 9) }}
    >
      <canvas
        ref={setup}
        class="optix-map-canvas"
        onPointerDown={(ev) => {
          const p = props.onProbe && world(ev);
          if (!p) return;
          dragging = true;
          try {
            canvas.setPointerCapture(ev.pointerId);
          } catch {
            // synthetic pointer ids can't be captured — dragging still works
          }
          props.onProbe?.(p);
        }}
        onPointerMove={(ev) => {
          if (!dragging) return;
          const p = props.onProbe && world(ev);
          if (p) props.onProbe?.(p);
        }}
        onPointerUp={() => {
          dragging = false;
        }}
      />
      <svg
        class="optix-map-overlay"
        viewBox={viewBox()}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <g transform="scale(1,-1)">{props.overlay}</g>
      </svg>
    </div>
  );
}
