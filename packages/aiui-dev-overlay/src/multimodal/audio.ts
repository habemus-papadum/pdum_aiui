/**
 * Mic capture. Two shapes behind one file:
 *
 *  - {@link AudioCapture} — the REST path: one getUserMedia stream, one
 *    MediaRecorder run per talk segment, yielding a **whole webm/opus blob** the
 *    `openai` transcriber uploads. An AnalyserNode drives the HUD level meter so
 *    "is it hearing me" is answered by pixels, not faith. Graduated from the
 *    workbench verbatim.
 *  - {@link WorkletPcmSource} — the realtime path (streaming-turns.md §3): an
 *    AudioWorklet taps the mic and emits **Int16 PCM frames at 24 kHz** *while
 *    you talk*, which the modality streams as `audio` chunks. MediaRecorder's
 *    timesliced webm fragments aren't independently decodable, and the realtime
 *    API wants raw PCM anyway — so realtime gets its own capture, behind the
 *    {@link PcmSource} seam (injectable, so jsdom — which has no AudioWorklet —
 *    supplies a fake).
 */
export class AudioCapture {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private analyser: AnalyserNode | undefined;
  private levelData: Uint8Array<ArrayBuffer> | undefined;

  async ensureStream(): Promise<boolean> {
    if (this.stream) {
      return true;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.levelData = new Uint8Array(this.analyser.frequencyBinCount);
      source.connect(this.analyser);
      return true;
    } catch {
      return false; // no mic / denied — talking degrades to nothing, visibly
    }
  }

  /** 0..1 RMS-ish level for the meter; 0 when no stream. */
  level(): number {
    if (!this.analyser || !this.levelData) {
      return 0;
    }
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const value of this.levelData) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 3);
  }

  start(): boolean {
    if (!this.stream || this.recorder) {
      return false;
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: preferredMime() });
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    });
    this.recorder.start();
    return true;
  }

  async stop(): Promise<Blob | undefined> {
    const recorder = this.recorder;
    this.recorder = undefined;
    if (!recorder || recorder.state === "inactive") {
      return undefined;
    }
    const done = new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    recorder.stop();
    await done;
    return this.chunks.length ? new Blob(this.chunks, { type: recorder.mimeType }) : undefined;
  }

  dispose(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
  }
}

function preferredMime(): string {
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

/** The realtime session's input rate (see the realtime transcriber). */
export const REALTIME_PCM_RATE = 24000;
/** MIME the realtime `audio` chunks declare. */
export const REALTIME_PCM_MIME = `audio/pcm;rate=${REALTIME_PCM_RATE}`;
/** ~ frame cadence: how much audio each streamed PCM frame carries. */
const PCM_FRAME_MS = 120;

/**
 * A streaming PCM capture source — the realtime path's seam. `start` begins
 * emitting Int16 mono frames at {@link REALTIME_PCM_RATE}; `stop` flushes the
 * tail and stops; `level` feeds the meter. Injectable so tests (and jsdom, which
 * has no AudioWorklet) supply a fake in place of {@link WorkletPcmSource}.
 */
export interface PcmSource {
  /** Acquire the mic + worklet and start emitting frames. False if unavailable. */
  start(onFrame: (frame: Int16Array) => void): Promise<boolean>;
  /** Stop emitting; resolves after the final (partial) frame is delivered. */
  stop(): Promise<void>;
  /** 0..1 RMS-ish level for the meter; 0 when not capturing. */
  level(): number;
  /** Release the mic + audio graph. */
  dispose(): void;
}

/** The AudioWorklet module: forwards each mono input quantum to the main thread. */
const PCM_WORKLET_SOURCE = `
class AiuiPcmForwarder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) { this.port.postMessage(ch.slice(0)); }
    return true;
  }
}
registerProcessor('aiui-pcm-forwarder', AiuiPcmForwarder);
`;

/** Linear-resample a Float32 block from `fromRate` to `toRate`. */
function resampleFloat(block: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || block.length === 0) {
    return block;
  }
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.floor(block.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, block.length - 1);
    out[i] = block[i0] + (block[i1] - block[i0]) * (src - i0);
  }
  return out;
}

/** Float32 [-1,1] → Int16LE. */
function floatToInt16(block: Float32Array): Int16Array {
  const out = new Int16Array(block.length);
  for (let i = 0; i < block.length; i++) {
    const clamped = Math.max(-1, Math.min(1, block[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/**
 * The real {@link PcmSource}: getUserMedia → AudioContext → AudioWorklet, tapping
 * mono Float32 at the context rate, resampled to 24 kHz Int16 in ~120 ms frames.
 * Everything DOM/Web-Audio lives inside `start` so importing this in jsdom is
 * safe (only `start` touches APIs jsdom lacks; it returns false there).
 */
export class WorkletPcmSource implements PcmSource {
  private stream: MediaStream | undefined;
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private analyser: AnalyserNode | undefined;
  private levelData: Uint8Array<ArrayBuffer> | undefined;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private onFrame: ((frame: Int16Array) => void) | undefined;

  async start(onFrame: (frame: Int16Array) => void): Promise<boolean> {
    if (this.node) {
      return true;
    }
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia || typeof AudioContext === "undefined") {
      return false; // no mic API / no Web Audio — realtime can't capture here
    }
    try {
      this.stream = await media.getUserMedia({ audio: true });
      this.ctx = new AudioContext();
      if (!this.ctx.audioWorklet) {
        this.teardown();
        return false; // no AudioWorklet — do NOT silently fall back
      }
      const moduleUrl = URL.createObjectURL(
        new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }),
      );
      try {
        await this.ctx.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.levelData = new Uint8Array(this.analyser.frequencyBinCount);
      source.connect(this.analyser);
      this.node = new AudioWorkletNode(this.ctx, "aiui-pcm-forwarder");
      this.onFrame = onFrame;
      const blockSamples = Math.round((this.ctx.sampleRate * PCM_FRAME_MS) / 1000);
      this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.pending.push(event.data);
        this.pendingLen += event.data.length;
        while (this.pendingLen >= blockSamples) {
          this.emitBlock(blockSamples);
        }
      };
      source.connect(this.node);
      return true;
    } catch {
      this.teardown();
      return false; // denied / worklet load failure — surfaced by the modality
    }
  }

  /** Drain `count` source samples, resample to 24 kHz Int16, and emit. */
  private emitBlock(count: number): void {
    const block = new Float32Array(count);
    let filled = 0;
    while (filled < count && this.pending.length > 0) {
      const head = this.pending[0];
      const take = Math.min(head.length, count - filled);
      block.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) {
        this.pending.shift();
      } else {
        this.pending[0] = head.subarray(take);
      }
    }
    this.pendingLen -= filled;
    const rate = this.ctx?.sampleRate ?? REALTIME_PCM_RATE;
    const pcm = floatToInt16(resampleFloat(block.subarray(0, filled), rate, REALTIME_PCM_RATE));
    this.onFrame?.(pcm);
  }

  async stop(): Promise<void> {
    // Flush whatever partial frame remains so the tail of the segment isn't lost.
    if (this.pendingLen > 0) {
      this.emitBlock(this.pendingLen);
    }
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = undefined;
    }
    this.onFrame = undefined;
    this.pending = [];
    this.pendingLen = 0;
  }

  level(): number {
    if (!this.analyser || !this.levelData) {
      return 0;
    }
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const value of this.levelData) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 3);
  }

  private teardown(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    void this.ctx?.close().catch(() => {});
    this.stream = undefined;
    this.ctx = undefined;
    this.node = undefined;
    this.analyser = undefined;
    this.levelData = undefined;
  }

  dispose(): void {
    void this.stop();
    this.teardown();
  }
}
