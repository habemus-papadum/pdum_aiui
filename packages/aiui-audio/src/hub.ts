import { choice, createClaims, createModeEngine, toggle } from "@habemus-papadum/aiui-viz/modal";
import { type BrowserAudioOptions, browserAudioDriver } from "./browser";
import { floatToPcm16, resampleLinear } from "./pcm";
import type {
  AudioDriver,
  AudioIdentity,
  AudioOutput,
  AudioSnapshot,
  InputSource,
  PcmInput,
  StreamInput,
} from "./types";

export interface AudioHubOptions extends BrowserAudioOptions {
  driver?: AudioDriver;
}

export interface AudioHub {
  pcmInput(identity: AudioIdentity & { sampleRate?: number }): PcmInput;
  streamInput(identity: AudioIdentity): StreamInput;
  output(identity: AudioIdentity): AudioOutput;
  startMicrophone(options?: {
    deviceId?: string;
    constraints?: MediaTrackConstraints;
  }): Promise<void>;
  /** Plays at real time through the same graph as a microphone, without permission prompts. */
  startRecording(
    samples: Float32Array,
    sampleRate: number,
    options?: { loop?: boolean },
  ): Promise<void>;
  stopMicrophone(): void;
  selectInput(id: string | undefined): Promise<void>;
  /** One temporary override. A newer override supersedes it; manual selection cancels it. */
  temporarilyRouteInput(id: string): { release(): Promise<void> };
  parkInput(): Promise<void>;
  resumeInput(): Promise<void>;
  selectOutput(id: string | undefined): void;
  muteOutput(muted: boolean): void;
  setVolume(value: number): void;
  setOutputDevice(id: string): Promise<void>;
  resumePlayback(): Promise<void>;
  snapshot(): AudioSnapshot;
  level(): number;
  subscribe(listener: (state: AudioSnapshot) => void): () => void;
  dispose(): Promise<void>;
}

interface InputEntry extends AudioIdentity {
  routeKey: string;
  kind: "pcm" | "stream";
  enabled: boolean;
  sampleRate: number;
  push?: (bytes: Uint8Array) => void;
}
interface OutputEntry extends AudioIdentity {
  element?: HTMLAudioElement;
}
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createAudioHub(options: AudioHubOptions = {}): AudioHub {
  const driver = options.driver ?? browserAudioDriver(options);
  const inputs = new Map<string, InputEntry>();
  const routes = new Map<string, InputEntry>();
  let registration = 0;
  const outputs = new Map<string, OutputEntry>();
  // Choices are the registered endpoint IDs. Removed IDs remain legal history,
  // but cannot be selected or routed until they are registered again.
  const inputIds = [""];
  const outputIds = [""];
  let source: InputSource = { kind: "microphone" };
  let sourceVersion = 0;
  let disposed = false;
  let capture: AudioSnapshot["capture"] = "off";
  let error: string | undefined;
  let activeInput: string | undefined;
  let routeVersion = 0;
  let appliedRoute: string | undefined;
  let routed: Promise<void> = Promise.resolve();
  let temporaryVersion = 0;
  let volume = 1;
  let sinkId = "";
  let playbackBlocked = false;
  const listeners = new Set<(state: AudioSnapshot) => void>();
  const machine = createModeEngine(
    {
      regions: {
        capture: toggle(),
        parked: toggle(),
        input: choice(inputIds),
        temporary: choice(inputIds),
        output: choice(outputIds),
        outputMuted: toggle(),
      },
      commands: {
        start: () => ({ capture: true }),
        stop: () => ({ capture: false }),
        select: (_s, id) => ({ input: id as string, temporary: "" }),
        temporary: (_s, id) => ({ temporary: id as string }),
        park: () => ({ parked: true }),
        resume: () => ({ parked: false }),
        output: (_s, id) => ({ output: id as string }),
        mute: (_s, muted) => ({ outputMuted: muted as boolean }),
      },
    },
    { context: { sourceVersion: 0 } },
  );
  const selected = (): string | undefined =>
    (machine.state().temporary || machine.state().input || undefined) as string | undefined;
  const snapshot = (): AudioSnapshot => ({
    capture,
    source: source.kind,
    deviceId: source.kind === "microphone" ? (source.deviceId ?? "") : "",
    ...(error ? { error } : {}),
    parked: machine.state().parked === true,
    selectedInput: selected(),
    activeInput,
    inputs: [...inputs.values()].map(({ id, label, icon, kind, enabled }) => ({
      id,
      label,
      icon,
      kind,
      enabled,
    })),
    outputs: [...outputs.values()].map(({ id, label, icon, element }) => ({
      id,
      label,
      icon,
      attached: !!element?.srcObject,
    })),
    selectedOutput: (machine.state().output || undefined) as string | undefined,
    outputMuted: machine.state().outputMuted === true,
    volume,
    sinkId,
    playbackBlocked,
  });
  const notify = () => {
    const value = snapshot();
    for (const listener of listeners) listener(value);
  };
  const reconcileRoute = () => {
    const want = selected();
    const next =
      capture === "active" && !machine.state().parked && want && inputs.get(want)?.enabled
        ? want
        : undefined;
    if (appliedRoute === next) {
      notify();
      return;
    }
    appliedRoute = next;
    activeInput = undefined; // no optimistic "sending" during a processor fence
    const version = ++routeVersion;
    routed = driver
      .route(next ? inputs.get(next)?.routeKey : undefined)
      .then(() => {
        if (version === routeVersion) {
          activeInput = next;
          notify();
        }
      })
      .catch((cause) => {
        if (version === routeVersion) {
          error = message(cause);
          activeInput = undefined;
          machine.dispatch("park");
          notify();
        }
        throw cause;
      });
    void routed.catch(() => {}); // errors also travel through the observable state
    notify();
  };
  const updatePlayback = () => {
    for (const [id, output] of outputs) {
      if (!output.element) continue;
      output.element.muted = machine.state().outputMuted === true || machine.state().output !== id;
      output.element.volume = volume;
    }
  };
  const claims = createClaims(
    {
      capture: {
        derive: (state, ctx: { sourceVersion: number }) =>
          state.capture && !disposed ? ctx.sourceVersion : null,
        async acquire(version: number, signal: AbortSignal) {
          const release = await driver.capture(source, signal, () => {
            void driver
              .flush()
              .catch((cause) => {
                error = message(cause);
              })
              .finally(() => {
                if (version === sourceVersion) machine.dispatch("stop");
              });
          });
          if (signal.aborted) {
            release();
            throw new DOMException("Capture cancelled", "AbortError");
          }
          return release;
        },
        release: (release: () => void) => release(),
        ceilingMs: 60_000,
      },
    },
    {
      getState: machine.state,
      getCtx: machine.context,
      onError: (_name, cause) => {
        error = message(cause);
        notify();
      },
      onStatus: (_name, state) => {
        if (state.phase === "error") error = message(state.error);
        capture =
          state.phase === "active"
            ? "active"
            : state.phase === "error"
              ? "error"
              : state.phase === "pending" && state.desire !== undefined
                ? "starting"
                : "off";
        reconcileRoute();
      },
    },
  );
  machine.subscribe(() => {
    claims.reconcile();
    reconcileRoute();
    updatePlayback();
  });
  driver.onPcm((id, samples, rate) => {
    // Samples carry their capture-time route through the asynchronous worklet.
    const endpoint = routes.get(id);
    if (!disposed && capture === "active" && endpoint?.enabled && endpoint.push)
      endpoint.push(floatToPcm16(resampleLinear(samples, rate, endpoint.sampleRate)));
  });
  const start = (nextSource: InputSource): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Audio hub is disposed"));
    error = undefined;
    source = nextSource;
    const version = ++sourceVersion;
    machine.setContext({ sourceVersion });
    machine.dispatch("start");
    claims.retry("capture");
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (version !== sourceVersion) {
          listeners.delete(check);
          reject(new Error("Capture superseded"));
        } else if (capture === "active") {
          listeners.delete(check);
          resolve();
        } else if (capture === "error" || !machine.state().capture || disposed) {
          listeners.delete(check);
          reject(new Error(error ?? "Capture cancelled"));
        }
      };
      listeners.add(check);
      check();
    });
  };
  const input = (identity: AudioIdentity, kind: "pcm" | "stream", sampleRate = 24000) => {
    if (!identity.id || inputs.has(identity.id))
      throw new Error(`Audio input already registered or empty: ${identity.id}`);
    if (!inputIds.includes(identity.id)) inputIds.push(identity.id);
    const entry: InputEntry = {
      ...identity,
      routeKey: `${identity.id}:${++registration}`,
      kind,
      enabled: false,
      sampleRate,
    };
    inputs.set(identity.id, entry);
    routes.set(entry.routeKey, entry);
    notify();
    return {
      ...identity,
      setEnabled(enabled: boolean) {
        if (inputs.get(identity.id) !== entry) return;
        entry.enabled = enabled;
        reconcileRoute();
      },
      dispose() {
        if (inputs.get(identity.id) !== entry) return;
        entry.enabled = false;
        entry.push = undefined;
        inputs.delete(identity.id);
        routes.delete(entry.routeKey);
        driver.removeStream(entry.routeKey);
        reconcileRoute();
      },
      entry,
    };
  };
  const checkInput = (id: string | undefined) => {
    if (id !== undefined && !inputs.has(id)) throw new Error(`Unknown audio input: ${id}`);
  };
  const hub: AudioHub = {
    pcmInput(identity) {
      const { entry, ...base } = input(identity, "pcm", identity.sampleRate);
      return {
        ...base,
        kind: "pcm",
        sampleRate: entry.sampleRate,
        async start(push) {
          if (inputs.get(identity.id) !== entry) throw new Error("Audio input disposed");
          entry.push = push;
          entry.enabled = true;
          reconcileRoute();
          await routed;
        },
        stop() {
          entry.enabled = false;
          entry.push = undefined;
          reconcileRoute();
        },
        flush: () => driver.flush(),
        level: () => driver.level(),
      };
    },
    streamInput(identity) {
      const { entry, ...base } = input(identity, "stream");
      return {
        ...base,
        kind: "stream",
        stream: () => {
          if (inputs.get(identity.id) !== entry) throw new Error("Audio input disposed");
          return driver.stream(entry.routeKey);
        },
        settings: () => driver.settings(),
        applyConstraints: (constraints) => driver.applyConstraints(constraints),
      };
    },
    output(identity) {
      if (!identity.id || outputs.has(identity.id))
        throw new Error(`Audio output already registered or empty: ${identity.id}`);
      if (!outputIds.includes(identity.id)) outputIds.push(identity.id);
      const entry: OutputEntry = { ...identity };
      outputs.set(identity.id, entry);
      notify();
      const detach = () => {
        if (entry.element) {
          entry.element.pause();
          entry.element.srcObject = null;
          entry.element = undefined;
        }
        notify();
      };
      return {
        ...identity,
        attach(stream, supplied) {
          if (outputs.get(identity.id) !== entry) return;
          detach();
          entry.element = supplied ?? document.createElement("audio");
          const element = entry.element;
          element.autoplay = true;
          element.srcObject = stream;
          updatePlayback();
          void (async () => {
            try {
              if (sinkId && element.setSinkId) await element.setSinkId(sinkId);
              if (entry.element === element) await element.play();
            } catch {
              if (entry.element !== element) return;
              playbackBlocked = true;
              notify();
            }
          })();
          notify();
        },
        detach,
        dispose() {
          if (outputs.get(identity.id) !== entry) return;
          detach();
          outputs.delete(identity.id);
          notify();
        },
      };
    },
    startMicrophone(opts = {}) {
      if (
        capture === "active" &&
        source.kind === "microphone" &&
        opts.deviceId === undefined &&
        opts.constraints === undefined
      )
        return Promise.resolve();
      return start({ kind: "microphone", ...opts });
    },
    startRecording: (samples, sampleRate, opts = {}) =>
      start({ kind: "recording", samples, sampleRate, ...opts }),
    stopMicrophone() {
      machine.dispatch("stop");
      activeInput = undefined;
      notify();
    },
    selectInput(id) {
      checkInput(id);
      temporaryVersion++;
      machine.dispatch("select", id ?? "");
      return routed;
    },
    temporarilyRouteInput(id) {
      checkInput(id);
      const version = ++temporaryVersion;
      machine.dispatch("temporary", id);
      return {
        release() {
          if (version === temporaryVersion) {
            temporaryVersion++;
            machine.dispatch("temporary", "");
          }
          return routed;
        },
      };
    },
    parkInput() {
      machine.dispatch("park");
      return routed;
    },
    resumeInput() {
      machine.dispatch("resume");
      return routed;
    },
    selectOutput(id) {
      if (id !== undefined && !outputs.has(id)) throw new Error(`Unknown audio output: ${id}`);
      machine.dispatch("output", id ?? "");
      notify();
    },
    muteOutput(muted) {
      machine.dispatch("mute", muted);
      notify();
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value));
      updatePlayback();
      notify();
    },
    async setOutputDevice(id) {
      for (const { element } of outputs.values()) {
        if (!element) continue;
        if (!element.setSinkId)
          throw new Error("Output device selection is unavailable in this browser");
        await element.setSinkId(id);
      }
      sinkId = id;
      notify();
    },
    async resumePlayback() {
      try {
        await Promise.all([...outputs.values()].map(({ element }) => element?.play()));
        playbackBlocked = false;
      } catch (cause) {
        playbackBlocked = true;
        throw cause;
      } finally {
        notify();
      }
    },
    snapshot,
    level: () => (capture === "active" ? driver.level() : 0),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      machine.dispatch("stop");
      notify();
      await claims.dispose();
      for (const output of outputs.values()) {
        output.element?.pause();
        if (output.element) output.element.srcObject = null;
      }
      outputs.clear();
      inputs.clear();
      routes.clear();
      driver.dispose();
      listeners.clear();
    },
  };
  return hub;
}

/** Explicit user-action wiring for a session's connect/resume button. */
export interface SessionAudio {
  hub: AudioHub;
  input: string;
  output?: string;
}
export async function activateSessionAudio(audio: SessionAudio): Promise<void> {
  if (audio.hub.snapshot().capture !== "active") await audio.hub.startMicrophone();
  await audio.hub.selectInput(audio.input);
  if (audio.output) audio.hub.selectOutput(audio.output);
}
