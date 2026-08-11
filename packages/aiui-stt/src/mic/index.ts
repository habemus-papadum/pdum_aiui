/**
 * aiui-stt/mic — the real microphone {@link AudioSource}: getUserMedia →
 * AudioContext → AudioWorklet, tapping mono Float32 at the context rate,
 * resampled to 24 kHz PCM16 frames. A separable implementation of the
 * injected-audio seam (proposal D4) — an app feeding its own PCM never
 * imports this subpath.
 *
 * The capture core is ported from `aiui-intent-runtime/src/audio.ts`'s
 * `WorkletPcmSource` — the shipped, browser-proven path (including its
 * recorded facts: the worklet module loads from a blob: URL, which MV3
 * extension pages' CSP rejects — hence `workletUrl` for hosts that must
 * ship the module as a real file — and jsdom has no AudioWorklet, so
 * `start` rejects rather than silently falling back). Written to be
 * promotable to a shared audio package when the oracle's transports ask;
 * no shared dependency is created now.
 */

import type { AudioSource } from "../types";

/** Both engines' input rate; the resample target. */
export const MIC_SAMPLE_RATE = 24000;

/** How much audio each emitted frame carries, by default. */
export const DEFAULT_MIC_FRAME_MS = 120;

/**
 * The AudioWorklet module source: forwards each mono input quantum to the
 * main thread. Exported so hosts that cannot load blob: scripts (MV3 CSP)
 * can ship it as a real file and pass its URL.
 */
export const MIC_WORKLET_SOURCE = `
class AiuiSttPcmForwarder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) { this.port.postMessage(ch.slice(0)); }
    return true;
  }
}
registerProcessor('aiui-stt-pcm-forwarder', AiuiSttPcmForwarder);
`;

/** Linear-resample a Float32 block from `fromRate` to `toRate`. */
export function resampleLinear(
  block: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
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

/** Float32 [-1,1] → little-endian PCM16 bytes. */
export function floatToPcm16(block: Float32Array): Uint8Array {
  const out = new Int16Array(block.length);
  for (let i = 0; i < block.length; i++) {
    const clamped = Math.max(-1, Math.min(1, block[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

export interface MicAudioSourceOptions {
  /** A specific input device (from {@link listMicrophones} / `MicPicker`). */
  deviceId?: string;
  /** Frame size in ms. Default {@link DEFAULT_MIC_FRAME_MS}. */
  frameMs?: number;
  /** Load the worklet module from this URL instead of a blob: of
   * {@link MIC_WORKLET_SOURCE} (MV3 CSP — see the module header). */
  workletUrl?: string;
}

/** The real microphone. One instance = one capture graph; `stop` releases it. */
export function micAudioSource(options: MicAudioSourceOptions = {}): AudioSource {
  let stream: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let analyser: AnalyserNode | undefined;
  let levelData: Uint8Array<ArrayBuffer> | undefined;
  let pending: Float32Array[] = [];
  let pendingLen = 0;
  let emit: ((pcm16: Uint8Array) => void) | undefined;

  /** Drain `count` source samples, resample to 24 kHz PCM16, and emit. */
  const emitBlock = (count: number): void => {
    const block = new Float32Array(count);
    let filled = 0;
    while (filled < count && pending.length > 0) {
      const head = pending[0];
      const take = Math.min(head.length, count - filled);
      block.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) {
        pending.shift();
      } else {
        pending[0] = head.subarray(take);
      }
    }
    pendingLen -= filled;
    const rate = ctx?.sampleRate ?? MIC_SAMPLE_RATE;
    emit?.(floatToPcm16(resampleLinear(block.subarray(0, filled), rate, MIC_SAMPLE_RATE)));
  };

  const teardown = (): void => {
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    void ctx?.close().catch(() => {});
    stream = undefined;
    ctx = undefined;
    node = undefined;
    analyser = undefined;
    levelData = undefined;
    pending = [];
    pendingLen = 0;
    emit = undefined;
  };

  return {
    sampleRate: MIC_SAMPLE_RATE,
    async start(onFrame) {
      if (node !== undefined) {
        emit = onFrame; // already capturing — re-point the sink
        return;
      }
      const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!media?.getUserMedia || typeof AudioContext === "undefined") {
        throw new Error("no microphone API in this environment");
      }
      stream = await media.getUserMedia({
        audio: options.deviceId !== undefined ? { deviceId: { exact: options.deviceId } } : true,
      });
      ctx = new AudioContext();
      if (!ctx.audioWorklet) {
        teardown();
        throw new Error("AudioWorklet unavailable — cannot capture PCM");
      }
      const moduleUrl =
        options.workletUrl ??
        URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(moduleUrl);
      } finally {
        if (options.workletUrl === undefined) {
          URL.revokeObjectURL(moduleUrl);
        }
      }
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      levelData = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      node = new AudioWorkletNode(ctx, "aiui-stt-pcm-forwarder");
      emit = onFrame;
      const blockSamples = Math.round(
        (ctx.sampleRate * (options.frameMs ?? DEFAULT_MIC_FRAME_MS)) / 1000,
      );
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        pending.push(event.data);
        pendingLen += event.data.length;
        while (pendingLen >= blockSamples) {
          emitBlock(blockSamples);
        }
      };
      source.connect(node);
    },
    flush() {
      if (pendingLen > 0) {
        emitBlock(pendingLen);
      }
    },
    stop() {
      if (node !== undefined) {
        node.port.onmessage = null;
        node.disconnect();
      }
      teardown();
    },
    level() {
      if (!analyser || !levelData) {
        return 0;
      }
      analyser.getByteTimeDomainData(levelData);
      let sum = 0;
      for (const value of levelData) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      return Math.min(1, Math.sqrt(sum / levelData.length) * 3);
    },
  };
}

/** One selectable input device. Labels are empty until mic permission exists. */
export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

/** Enumerate audio inputs (the `MicPicker`'s data source). */
export async function listMicrophones(): Promise<MicrophoneInfo[]> {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) {
    return [];
  }
  const devices = await media.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

export { MicPicker, type MicPickerProps } from "./MicPicker";
