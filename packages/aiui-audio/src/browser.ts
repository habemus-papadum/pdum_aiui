import type { AudioDriver, InputSource } from "./types";

export const ECHO_SAFE_AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Route labels travel WITH samples. A queued frame can never land in a new consumer. */
export const AUDIO_WORKLET_SOURCE = `
class AiuiAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.route = ''; this.chunks = []; this.length = 0;
    this.port.onmessage = ({data}) => {
      this.flush();
      if (data.route !== undefined) this.route = data.route;
      this.port.postMessage({ack: data.sequence});
    };
  }
  flush() {
    if (this.length && this.route) {
      const samples = new Float32Array(this.length); let offset = 0;
      for (const chunk of this.chunks) { samples.set(chunk, offset); offset += chunk.length; }
      this.port.postMessage({route: this.route, samples, sampleRate}, [samples.buffer]);
    }
    this.chunks = []; this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (this.route && channels && channels.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      this.chunks.push(mono); this.length += mono.length;
      if (this.length >= sampleRate / 10) this.flush();
    }
    return true;
  }
}
registerProcessor('aiui-audio-capture', AiuiAudioCapture);
`;

export interface BrowserAudioOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createContext?: () => AudioContext;
  /** Hosts with restrictive CSP can serve AUDIO_WORKLET_SOURCE as a file. */
  workletUrl?: string;
}

export function browserAudioDriver(options: BrowserAudioOptions = {}): AudioDriver {
  let context: AudioContext | undefined;
  let bus: GainNode;
  let analyser: AnalyserNode;
  let worklet: AudioWorkletNode | undefined;
  let loading: Promise<void> | undefined;
  let mic: MediaStream | undefined;
  let sequence = 0;
  let route: string | undefined;
  let disposed = false;
  const waiters = new Map<
    number,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const streams = new Map<string, { gate: GainNode; output: MediaStreamAudioDestinationNode }>();
  let onPcm: Parameters<AudioDriver["onPcm"]>[0] = () => {};
  const ensure = (): AudioContext => {
    if (disposed) throw new Error("Audio hub is disposed");
    if (!context) {
      context = (options.createContext ?? (() => new AudioContext()))();
      bus = context.createGain();
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      bus.connect(analyser);
    }
    return context;
  };
  const load = (): Promise<void> => {
    if (loading) return loading;
    const ctx = ensure();
    loading = (async () => {
      const url =
        options.workletUrl ??
        URL.createObjectURL(new Blob([AUDIO_WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
        if (disposed) throw new Error("Audio hub is disposed");
        worklet = new AudioWorkletNode(ctx, "aiui-audio-capture");
        worklet.port.onmessage = ({ data }) => {
          if (data.ack !== undefined) {
            const waiter = waiters.get(data.ack);
            if (waiter) {
              clearTimeout(waiter.timer);
              waiters.delete(data.ack);
              waiter.resolve();
            }
          } else if (data.route) onPcm(data.route, data.samples, data.sampleRate);
        };
        // A silent output keeps the processor pulled without monitoring the mic.
        const silent = ctx.createGain();
        silent.gain.value = 0;
        bus.connect(worklet);
        worklet.connect(silent);
        silent.connect(ctx.destination);
      } finally {
        if (!options.workletUrl) URL.revokeObjectURL(url);
      }
    })().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  const fence = (nextRoute?: string): Promise<void> => {
    if (!worklet || context?.state !== "running") return Promise.resolve();
    const id = ++sequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error("Audio processor did not acknowledge routing"));
      }, 2000);
      waiters.set(id, { resolve, reject, timer });
      worklet?.port.postMessage({
        sequence: id,
        ...(nextRoute !== undefined ? { route: nextRoute } : {}),
      });
    });
  };
  return {
    async capture(source: InputSource, signal, onEnded) {
      const ctx = ensure();
      // Call resume in the original user gesture, before awaiting permission.
      const resumed = ctx.resume();
      let stream: MediaStream | undefined;
      let node: AudioNode | undefined;
      let recording: AudioBufferSourceNode | undefined;
      const release = () => {
        node?.disconnect();
        if (recording) {
          recording.onended = null;
          try {
            recording.stop();
          } catch {}
        }
        for (const track of stream?.getTracks() ?? []) {
          track.onended = null;
          track.stop();
        }
        if (mic === stream) mic = undefined;
      };
      signal.addEventListener("abort", release, { once: true });
      try {
        if (source.kind === "microphone") {
          stream = await (options.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c)))({
            audio: {
              ...ECHO_SAFE_AUDIO,
              ...source.constraints,
              ...(source.deviceId ? { deviceId: { exact: source.deviceId } } : {}),
            },
          });
          if (signal.aborted) throw new DOMException("Capture cancelled", "AbortError");
          if (!stream.getAudioTracks().length)
            throw new Error("Microphone returned no audio track");
          mic = stream;
          for (const track of stream.getTracks()) track.onended = onEnded;
          node = ctx.createMediaStreamSource(stream);
        } else {
          if (!(source.sampleRate > 0) || !source.samples.length)
            throw new Error("Recording needs samples and a valid sample rate");
          const buffer = ctx.createBuffer(1, source.samples.length, source.sampleRate);
          buffer.copyToChannel(new Float32Array(source.samples), 0);
          recording = ctx.createBufferSource();
          recording.buffer = buffer;
          recording.loop = source.loop ?? false;
          recording.onended = onEnded;
          node = recording;
        }
        await resumed;
        await load();
        if (signal.aborted) throw new DOMException("Capture cancelled", "AbortError");
        await fence(route ?? "");
        node.connect(bus);
        recording?.start();
        return () => {
          signal.removeEventListener("abort", release);
          release();
        };
      } catch (error) {
        signal.removeEventListener("abort", release);
        release();
        // A rejected resume must not become an unhandled rejection on permission failure.
        await resumed.catch(() => {});
        throw error;
      }
    },
    async route(id) {
      route = id;
      for (const [key, { gate }] of streams) gate.gain.value = key === id ? 1 : 0;
      await fence(id ?? "");
    },
    flush: () => fence(),
    stream(id) {
      const ctx = ensure();
      let entry = streams.get(id);
      if (!entry) {
        const gate = ctx.createGain();
        gate.gain.value = route === id ? 1 : 0;
        const output = ctx.createMediaStreamDestination();
        output.channelCount = 1;
        bus.connect(gate);
        gate.connect(output);
        entry = { gate, output };
        streams.set(id, entry);
      }
      return entry.output.stream;
    },
    removeStream(id) {
      const entry = streams.get(id);
      if (entry) {
        bus.disconnect(entry.gate);
        entry.gate.disconnect();
        for (const track of entry.output.stream.getTracks()) track.stop();
        streams.delete(id);
      }
    },
    level() {
      if (context?.state !== "running") return 0;
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      return Math.min(1, Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length) * 3);
    },
    settings: () => mic?.getAudioTracks()[0]?.getSettings(),
    async applyConstraints(constraints) {
      const track = mic?.getAudioTracks()[0];
      if (!track) throw new Error("Microphone is off");
      await track.applyConstraints(constraints);
    },
    onPcm(callback) {
      onPcm = callback;
    },
    dispose() {
      disposed = true;
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Audio hub disposed"));
      }
      waiters.clear();
      for (const id of streams.keys()) this.removeStream(id);
      worklet?.disconnect();
      void context?.close().catch(() => {});
    },
  };
}
