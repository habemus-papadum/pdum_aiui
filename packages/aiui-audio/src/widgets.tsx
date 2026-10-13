import type { JSX } from "@solidjs/web";
import {
  createContext,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import type { AudioHub } from "./hub";
import type { AudioSnapshot } from "./types";

export function useAudioState(hub: AudioHub): () => AudioSnapshot {
  const [state, setState] = createSignal(hub.snapshot(), { ownedWrite: true });
  onCleanup(hub.subscribe(setState));
  return state;
}

export const AUDIO_WIDGET_STYLES = `
.aiui-audio { display: grid; gap: .6rem; font: inherit; color: var(--aiui-fg, inherit); min-width: 0; }
.aiui-audio-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
.aiui-audio label { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; min-width: 0; }
.aiui-audio select { max-width: 100%; min-width: 0; flex: 1; font: inherit; color: inherit; background: var(--aiui-bg, transparent); }
.aiui-audio button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--aiui-border, #8886); padding: .3rem .55rem; cursor: pointer; }
.aiui-audio button:disabled { opacity: .45; cursor: default; }
.aiui-audio meter { width: 5rem; height: .65rem; accent-color: var(--aiui-accent, #555); }
.aiui-audio-status { margin: 0; font-size: .85em; opacity: .8; }
.aiui-audio-error { margin: 0; color: var(--aiui-error, #a33); }
.aiui-audio details { font-size: .9em; }
.aiui-audio summary { cursor: pointer; }
.aiui-audio-settings { display: grid; gap: .65rem; padding-block: .6rem; }
`;

export function AudioMeter(props: { hub: AudioHub }) {
  const [level, setLevel] = createSignal(0);
  const timer = setInterval(() => setLevel(props.hub.level()), 80);
  onCleanup(() => clearInterval(timer));
  return <meter min="0" max="1" value={level()} aria-label="Microphone level" />;
}

export function AudioRoutePicker(props: { hub: AudioHub }) {
  const state = useAudioState(props.hub);
  return (
    <label>
      Send to
      <select
        aria-label="Audio input destination"
        value={state().selectedInput ?? ""}
        onChange={(event) => {
          void props.hub.selectInput(event.currentTarget.value || undefined).catch(() => {});
        }}
      >
        <option value="">Nobody</option>
        <For each={state().inputs} keyed={(input) => input.id}>
          {(input) => (
            <option value={input().id}>
              {input().icon ?? ""} {input().label}
              {input().enabled ? "" : " · not listening"}
            </option>
          )}
        </For>
      </select>
    </label>
  );
}

export function MicrophonePicker(props: { hub: AudioHub }) {
  const state = useAudioState(props.hub);
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [error, setError] = createSignal<string>();
  const refresh = () => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((items) => setDevices(items.filter((d) => d.kind === "audioinput")))
      .catch((e: Error) => setError(e.message));
  };
  createEffect(() => state().capture, refresh);
  navigator.mediaDevices?.addEventListener("devicechange", refresh);
  onCleanup(() => navigator.mediaDevices?.removeEventListener("devicechange", refresh));
  return (
    <>
      <label>
        Microphone
        <select
          aria-label="Microphone device"
          value={state().deviceId}
          onChange={(event) => {
            void props.hub
              .startMicrophone({ deviceId: event.currentTarget.value })
              .catch((e: Error) => setError(e.message));
          }}
        >
          <option value="">Default microphone</option>
          <For each={devices()} keyed={(device) => device.deviceId}>
            {(device, index) => (
              <option value={device().deviceId}>
                {device().label || `Microphone ${index() + 1}`}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={error()}>
        {(text) => (
          <p role="alert" class="aiui-audio-error">
            {text()}
          </p>
        )}
      </Show>
    </>
  );
}

export function AudioControl(props: { hub: AudioHub; class?: string }) {
  const state = useAudioState(props.hub);
  const [error, setError] = createSignal<string>();
  const run = (operation: () => Promise<unknown>) => {
    setError(undefined);
    void operation().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  const destination = () => state().inputs.find((input) => input.id === state().activeInput);
  const description = () => {
    const s = state();
    if (s.capture === "starting") return "Starting audio input…";
    if (s.capture === "off") return "Microphone off";
    if (s.capture === "error") return "Audio input unavailable";
    const source = s.source === "recording" ? "Recorded audio active" : "Microphone active";
    const target = destination();
    return target
      ? `${source} · sending to ${target.label}`
      : `${source} · not sending${s.parked ? " (parked)" : ""}`;
  };
  return (
    <div class={`aiui-audio ${props.class ?? ""}`}>
      <style>{AUDIO_WIDGET_STYLES}</style>
      <div class="aiui-audio-row">
        <span aria-hidden="true">🎙</span>
        <AudioMeter hub={props.hub} />
        <button
          type="button"
          onClick={() => {
            if (state().capture === "active" || state().capture === "starting")
              props.hub.stopMicrophone();
            else run(() => props.hub.startMicrophone());
          }}
        >
          {state().capture === "active" || state().capture === "starting"
            ? "Microphone off"
            : "Enable microphone"}
        </button>
        <button
          type="button"
          aria-pressed={state().parked ? "true" : "false"}
          onClick={() =>
            run(() => (state().parked ? props.hub.resumeInput() : props.hub.parkInput()))
          }
        >
          {state().parked ? "Resume input" : "Park input"}
        </button>
      </div>
      <AudioRoutePicker hub={props.hub} />
      <p class="aiui-audio-status" role="status">
        {destination()?.icon ?? ""} {description()}
      </p>
      <Show when={state().outputs.length > 0}>
        <div class="aiui-audio-row">
          <label>
            Hear
            <select
              aria-label="Audio playback source"
              value={state().selectedOutput ?? ""}
              onChange={(e) => props.hub.selectOutput(e.currentTarget.value || undefined)}
            >
              <option value="">Nobody</option>
              <For each={state().outputs} keyed={(output) => output.id}>
                {(output) => (
                  <option value={output().id}>
                    {output().icon ?? ""} {output().label}
                  </option>
                )}
              </For>
            </select>
          </label>
          <button
            type="button"
            aria-pressed={state().outputMuted ? "true" : "false"}
            onClick={() => props.hub.muteOutput(!state().outputMuted)}
          >
            {state().outputMuted ? "Unmute playback" : "Mute playback"}
          </button>
        </div>
      </Show>
      <details>
        <summary>Audio settings</summary>
        <div class="aiui-audio-settings">
          <MicrophonePicker hub={props.hub} />
          <label>
            Volume{" "}
            <input
              aria-label="Playback volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={state().volume}
              onInput={(e) => props.hub.setVolume(Number(e.currentTarget.value))}
            />
          </label>
          <Show
            when={
              typeof navigator !== "undefined" &&
              "selectAudioOutput" in (navigator.mediaDevices ?? {})
            }
          >
            <button
              type="button"
              onClick={() =>
                run(async () => {
                  const media = navigator.mediaDevices as MediaDevices & {
                    selectAudioOutput(): Promise<MediaDeviceInfo>;
                  };
                  const device = await media.selectAudioOutput();
                  await props.hub.setOutputDevice(device.deviceId);
                })
              }
            >
              Choose speakers or headphones
            </button>
          </Show>
        </div>
      </details>
      <Show when={state().playbackBlocked}>
        <button type="button" onClick={() => run(() => props.hub.resumePlayback())}>
          Enable playback
        </button>
      </Show>
      <Show when={error() ?? state().error}>
        {(text) => (
          <p class="aiui-audio-error" role="alert">
            {text()}
          </p>
        )}
      </Show>
    </div>
  );
}

// Solid 2 requires an explicit default for an optional provider.
const AudioContext = createContext<AudioHub | null>(null);
/** The application owns the hub; provider unmount does not dispose it. */
export function AudioProvider(props: { hub: AudioHub; children: JSX.Element }) {
  return <AudioContext value={props.hub}>{props.children}</AudioContext>;
}
export function useAudioHub(): AudioHub | undefined {
  return useContext(AudioContext) ?? undefined;
}
