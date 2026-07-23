/**
 * HoloFilmView.tsx — the 2-D film itself, as a WebGL island: the exposure
 * |R + ΣO|² evaluated per fragment (the same formula as window2d.ts's
 * exposure2DAt, mirrored in GLSL). Zoomed out, the plate is featureless
 * mottle — THERE IS NO PICTURE ON A HOLOGRAM; zoomed in, the actual fringes.
 * The bracket marks the pupil — the patch the window view looks through —
 * and dragging pans it. The view centres on the pupil, so zooming inspects
 * the fringes exactly where you are looking.
 *
 * Display note the caption repeats: between zoom levels the fringes are finer
 * than the screen pixels, and the shimmering moiré you see is aliasing — the
 * pattern outresolving your monitor is itself the point. (2×2 supersampling
 * keeps it from strobing.)
 */
import { createEffect, onCleanup, untrack } from "solid-js";
import { winAperture, winEyeX, winEyeY, winZoom } from "../model/store";
import { WINDOW_LAMBDA, WINDOW_REF_SIN, WINDOW_SCENE } from "../model/window2d";

const MAX_POINTS = 16;
const FULL_SPAN = 4000; // µm across the view at zoom 1

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = (aPos + 1.0) * 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uPoints[${MAX_POINTS}];
uniform int uCount;
uniform vec2 uCenter;   // view centre = pupil position, µm
uniform float uSpan;    // world µm across the view
uniform float uK;       // 2π/λ
uniform float uRefSin;
out vec4 frag;

float exposureAt(vec2 w) {
  float re = cos(uK * w.x * uRefSin);
  float im = sin(uK * w.x * uRefSin);
  for (int i = 0; i < ${MAX_POINTS}; i++) {
    if (i >= uCount) break;
    vec3 p = uPoints[i];
    float r = length(vec3(w - p.xy, p.z));
    float a = (0.11 * 2800.0) / r;
    float ph = uK * r;
    re += a * cos(ph);
    im += a * sin(ph);
  }
  return re * re + im * im;
}

void main() {
  vec2 w0 = uCenter + (vUv - 0.5) * uSpan;
  float px = uSpan * 0.25 * fwidth(vUv.x); // quarter-pixel offset for 2×2 supersample
  float e = exposureAt(w0 + vec2(-px, -px)) + exposureAt(w0 + vec2(px, -px)) +
            exposureAt(w0 + vec2(-px, px)) + exposureAt(w0 + vec2(px, px));
  e *= 0.25;
  float b = 1.0 - exp(-e * 0.5);
  frag = vec4(vec3(0.93, 0.87, 0.72) * b, 1.0);
}`;

export function HoloFilmView() {
  let canvas!: HTMLCanvasElement;
  let gl: WebGL2RenderingContext | null = null;
  let uCenter: WebGLUniformLocation | null = null;
  let uSpan: WebGLUniformLocation | null = null;
  let ro: ResizeObserver | undefined;
  // mirrored lets: draw() never touches a reactive getter
  let cx = 0;
  let cy = 0;
  let zoomV = 1;

  onCleanup(() => {
    ro?.disconnect();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  });

  const draw = (): void => {
    if (!gl) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uCenter, cx, cy);
    gl.uniform1f(uSpan, FULL_SPAN / zoomV);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const setup = (el: HTMLCanvasElement): void => {
    canvas = el;
    gl = el.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) return;
    const compile = (type: number, src: string): WebGLShader => {
      const g = gl as WebGL2RenderingContext;
      const sh = g.createShader(type) as WebGLShader;
      g.shaderSource(sh, src);
      g.compileShader(sh);
      if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
        throw new Error(g.getShaderInfoLog(sh) ?? "compile failed");
      }
      return sh;
    };
    const prog = gl.createProgram() as WebGLProgram;
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

    // static uniforms: the scene, the light
    const pts = new Float32Array(MAX_POINTS * 3);
    WINDOW_SCENE.forEach((p, i) => {
      pts[i * 3] = p.x;
      pts[i * 3 + 1] = p.y;
      pts[i * 3 + 2] = p.z;
    });
    gl.uniform3fv(gl.getUniformLocation(prog, "uPoints"), pts);
    gl.uniform1i(gl.getUniformLocation(prog, "uCount"), WINDOW_SCENE.length);
    gl.uniform1f(gl.getUniformLocation(prog, "uK"), (2 * Math.PI) / WINDOW_LAMBDA);
    gl.uniform1f(gl.getUniformLocation(prog, "uRefSin"), WINDOW_REF_SIN);
    uCenter = gl.getUniformLocation(prog, "uCenter");
    uSpan = gl.getUniformLocation(prog, "uSpan");

    ro = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const holder = canvas.parentElement as HTMLElement;
      canvas.width = Math.max(1, Math.round(holder.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(holder.clientHeight * dpr));
      draw();
    });
    ro.observe(el.parentElement as HTMLElement);
  };

  // controls → repaint (tracked reads live in the compute; the handler
  // consumes the computed value)
  createEffect(
    () => ({ x: winEyeX.get(), y: winEyeY.get(), z: winZoom.get() }),
    (v) => {
      cx = v.x;
      cy = v.y;
      zoomV = v.z;
      draw();
    },
  );

  // drag pans the pupil (rAF-throttled: each move re-renders the film AND
  // recomputes the window view's 256² patch)
  let dragging = false;
  let pending: { dx: number; dy: number } | null = null;
  let last: { x: number; y: number } | null = null;
  let raf = 0;
  const flushDrag = (): void => {
    raf = 0;
    if (!pending) return;
    const span = FULL_SPAN / zoomV;
    const r = canvas.getBoundingClientRect();
    const scale = span / r.width;
    winEyeX.set(
      Math.max(
        -1200,
        Math.min(1200, Math.round(untrack(() => winEyeX.get()) - pending.dx * scale)),
      ),
    );
    winEyeY.set(
      Math.max(
        -1200,
        Math.min(1200, Math.round(untrack(() => winEyeY.get()) + pending.dy * scale)),
      ),
    );
    pending = null;
  };

  const apFrac = (): number => Math.min(1, winAperture.get() / (FULL_SPAN / winZoom.get()));

  return (
    <div class="film2d-wrap">
      <canvas
        ref={setup}
        class="film2d-canvas"
        onPointerDown={(ev) => {
          dragging = true;
          last = { x: ev.clientX, y: ev.clientY };
          try {
            canvas.setPointerCapture(ev.pointerId);
          } catch {
            /* synthetic pointers can't capture */
          }
        }}
        onPointerMove={(ev) => {
          if (!dragging || !last) return;
          pending = {
            dx: (pending?.dx ?? 0) + ev.clientX - last.x,
            dy: (pending?.dy ?? 0) + ev.clientY - last.y,
          };
          last = { x: ev.clientX, y: ev.clientY };
          if (!raf) raf = requestAnimationFrame(flushDrag);
        }}
        onPointerUp={() => {
          dragging = false;
          last = null;
        }}
      />
      {/* the pupil bracket — the view is centred on it by construction */}
      <div
        class="film2d-pupil"
        style={{
          width: `${(apFrac() * 100).toFixed(2)}%`,
          height: `${(apFrac() * 100).toFixed(2)}%`,
        }}
      />
    </div>
  );
}
