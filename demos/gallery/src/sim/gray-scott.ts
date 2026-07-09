/**
 * gray-scott.ts — the imperative WebGL2 core of the simulation.
 *
 * Deliberately NOT reactive: this is a durable, stateful island (the field
 * texture is the most precious state in the app — minutes of accrued
 * morphogenesis) driven at requestAnimationFrame rate. Reactivity stops at
 * its boundary: parameter changes are pushed in via `setParams` (an effect in
 * the model does this), and observations come out via `readback()` on a slow
 * cadence (the loop publishes snapshots into a signal). Putting the rAF hot
 * path through the reactive graph would be both slow and meaningless — no
 * consumer wants 60 Hz updates.
 *
 * HMR contract: the engine instance is owned by the durable registry (created
 * once, adopted forever); `recompile(shaders)` swaps the GLSL — disposable
 * logic — without touching the field textures — durable state.
 */
export interface SimParams {
  F: number;
  k: number;
  Du: number;
  Dv: number;
}

export interface Brush {
  x: number; // uv coords, 0..1
  y: number;
  radius: number; // uv units; 0 disables
}

export type SeedKind = "center" | "spots" | "noise" | "clear";

export interface ShaderSource {
  vertex: string;
  step: string;
  display: string;
  encode: string;
}

export class GrayScottEngine {
  readonly size: number;
  readonly gl: WebGL2RenderingContext;
  private fields: [WebGLTexture, WebGLTexture];
  private fbos: [WebGLFramebuffer, WebGLFramebuffer];
  private src = 0; // index of the current source texture
  private stepProg!: WebGLProgram;
  private displayProg!: WebGLProgram;
  private encodeProg!: WebGLProgram;
  private encodeFbo: WebGLFramebuffer;
  private encodeTex: WebGLTexture;
  private readbackBuf: Uint8Array;
  private params: SimParams = { F: 0.055, k: 0.062, Du: 1.0, Dv: 0.5 };
  private brush: Brush | null = null;
  private vao: WebGLVertexArrayObject;
  /** Total simulation steps taken since the last seed. */
  steps = 0;

  constructor(canvas: HTMLCanvasElement, size: number, shaders: ShaderSource) {
    this.size = size;
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is required for the simulation");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EXT_color_buffer_float is required (float render targets)");
    }
    this.gl = gl;
    this.vao = gl.createVertexArray();

    const makeField = (): [WebGLTexture, WebGLFramebuffer] => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, size, size, 0, gl.RG, gl.FLOAT, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return [tex, fbo];
    };
    const [t0, f0] = makeField();
    const [t1, f1] = makeField();
    this.fields = [t0, t1];
    this.fbos = [f0, f1];

    // Byte-encoded copy of the field for cheap readback.
    this.encodeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.encodeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.encodeFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.encodeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.encodeTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.readbackBuf = new Uint8Array(size * size * 4);

    this.recompile(shaders);
    this.seed("center");
  }

  /** Swap shader programs in place — the field textures are untouched. */
  recompile(shaders: ShaderSource): void {
    const gl = this.gl;
    const vertex = shaders.vertex;
    const build = (frag: string): WebGLProgram => {
      const compile = (type: number, source: string): WebGLShader => {
        const sh = gl.createShader(type);
        if (!sh) throw new Error("createShader failed");
        gl.shaderSource(sh, source);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error(`shader compile: ${gl.getShaderInfoLog(sh) ?? "unknown"}`);
        }
        return sh;
      };
      const prog = gl.createProgram();
      if (!prog) throw new Error("createProgram failed");
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`program link: ${gl.getProgramInfoLog(prog) ?? "unknown"}`);
      }
      return prog;
    };
    const next = {
      step: build(shaders.step),
      display: build(shaders.display),
      encode: build(shaders.encode),
    };
    // Only replace once all three compiled — a bad edit must not half-swap.
    for (const p of [this.stepProg, this.displayProg, this.encodeProg]) {
      if (p) gl.deleteProgram(p);
    }
    this.stepProg = next.step;
    this.displayProg = next.display;
    this.encodeProg = next.encode;
  }

  setParams(p: SimParams): void {
    this.params = p;
  }

  getParams(): SimParams {
    return { ...this.params };
  }

  setBrush(b: Brush | null): void {
    this.brush = b;
  }

  /** (Re)initialize the field. U = 1 everywhere; V per seed kind. */
  seed(kind: SeedKind): void {
    const { gl, size } = this;
    const data = new Float32Array(size * size * 2);
    for (let i = 0; i < size * size; i++) data[i * 2] = 1; // U = 1, V = 0
    const put = (x: number, y: number, v: number) => {
      const xi = ((x % size) + size) % size;
      const yi = ((y % size) + size) % size;
      data[(yi * size + xi) * 2 + 1] = v;
    };
    if (kind === "center") {
      const c = size / 2;
      const r = Math.max(4, Math.floor(size / 32));
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) put(c + x, c + y, 0.8 + 0.2 * Math.random());
    } else if (kind === "spots") {
      for (let s = 0; s < 24; s++) {
        const cx = Math.floor(Math.random() * size);
        const cy = Math.floor(Math.random() * size);
        for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) put(cx + x, cy + y, 0.9);
      }
    } else if (kind === "noise") {
      for (let i = 0; i < size * size; i++) {
        if (Math.random() < 0.05) data[i * 2 + 1] = Math.random();
      }
    } // "clear": V stays 0 — the pattern dissolves back to pure U
    for (const tex of this.fields) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RG, gl.FLOAT, data);
    }
    this.steps = 0;
  }

  /** Advance the simulation n steps (ping-pong between field textures). */
  step(n: number): void {
    const { gl, size } = this;
    gl.useProgram(this.stepProg);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, size, size);
    const loc = (name: string) => gl.getUniformLocation(this.stepProg, name);
    gl.uniform2f(loc("uTexel"), 1 / size, 1 / size);
    gl.uniform1f(loc("uF"), this.params.F);
    gl.uniform1f(loc("uK"), this.params.k);
    gl.uniform1f(loc("uDu"), this.params.Du);
    gl.uniform1f(loc("uDv"), this.params.Dv);
    const b = this.brush;
    for (let i = 0; i < n; i++) {
      // Apply the brush on the first step of the batch only.
      gl.uniform3f(loc("uBrush"), b?.x ?? 0, b?.y ?? 0, i === 0 && b ? b.radius : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1 - this.src]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fields[this.src]);
      gl.uniform1i(loc("uField"), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.src = 1 - this.src;
    }
    this.steps += n;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Draw the current field to the canvas. */
  present(): void {
    const { gl } = this;
    gl.useProgram(this.displayProg);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fields[this.src]);
    gl.uniform1i(gl.getUniformLocation(this.displayProg, "uField"), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Read the field back as bytes: RGBA rows, R = U·255, G = V·255. Returns a
   * view into a reused buffer — copy if you keep it (the analysis path does).
   */
  readback(): Uint8Array {
    const { gl, size } = this;
    gl.useProgram(this.encodeProg);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.encodeFbo);
    gl.viewport(0, 0, size, size);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fields[this.src]);
    gl.uniform1i(gl.getUniformLocation(this.encodeProg, "uField"), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, this.readbackBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.readbackBuf;
  }

  dispose(): void {
    const { gl } = this;
    for (const t of this.fields) gl.deleteTexture(t);
    for (const f of this.fbos) gl.deleteFramebuffer(f);
    gl.deleteTexture(this.encodeTex);
    gl.deleteFramebuffer(this.encodeFbo);
    for (const p of [this.stepProg, this.displayProg, this.encodeProg]) gl.deleteProgram(p);
  }
}
