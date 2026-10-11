import { bridgeEffect } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { targetLabel } from "./model";
import { pickCaptureElement } from "./picker";
import { observePreview, type PreviewStats } from "./preview";
import { captureTargetProps, elementCaptureIssue } from "./targets";
import type { CaptureSnapshot, CaptureTarget, CropMode, ScreenCapture } from "./types";

export function useScreenCaptureState(capture: ScreenCapture): () => CaptureSnapshot {
  const [state, setState] = createSignal(capture.snapshot(), { ownedWrite: true });
  onCleanup(capture.subscribe(setState));
  return state;
}

export const SCREEN_CAPTURE_STYLES = `
.aiui-capture { color:var(--aiui-ink,inherit); font: .85rem var(--aiui-sans,system-ui); min-width:0; }
.aiui-capture-controls { display:grid; gap:.8rem; }
.aiui-capture-row { display:flex; flex-wrap:wrap; align-items:center; gap:.65rem; }
.aiui-capture button,.aiui-capture select { font:inherit; color:inherit; background:var(--aiui-surface-raised,transparent); border:1px solid var(--aiui-hairline,#999); border-radius:0; padding:.5rem .7rem; max-width:100%; }
.aiui-capture button { cursor:pointer; }
.aiui-capture button:disabled { cursor:default; opacity:.5; }
.aiui-capture label { display:grid; gap:.35rem; }
.aiui-capture p { margin:0; font:inherit; }
.aiui-capture-note { color:var(--aiui-ink-muted,#666); line-height:1.5; }
.aiui-capture-error { color:var(--aiui-alarm,#933); }
.aiui-capture-dot { display:inline-block; width:.5rem; height:.5rem; border-radius:50%; background:var(--aiui-muted,#777); margin-right:.45rem; }
.aiui-capture-dot[data-state=active] { background:var(--aiui-ok,#487); }
.aiui-capture-dot[data-state=requesting] { background:var(--aiui-warn,#a83); }
.aiui-capture-dot[data-state=unavailable] { background:var(--aiui-warn,#a83); }
.aiui-capture-dot[data-state=error] { background:var(--aiui-alarm,#933); }
.aiui-capture-preview { margin:0; border:1px solid var(--aiui-hairline,#999); }
.aiui-capture-video { position:relative; min-height:10rem; background:var(--aiui-surface,#eee); }
.aiui-capture-video video { width:100%; max-height:65vh; display:block; object-fit:contain; }
.aiui-capture-empty { position:absolute; inset:0; display:grid; place-content:center; padding:1rem; text-align:center; }
.aiui-capture-preview figcaption { display:flex; flex-wrap:wrap; gap:.75rem; padding:.65rem; font:inherit; border-top:1px solid var(--aiui-hairline,#999); overflow-wrap:anywhere; }
`;

export interface NamedCaptureTarget {
  label: string;
  element: () => Element | undefined;
}

/** Capture actions plus optional named targets and an on-page element picker. */
export function ScreenCaptureControl(props: {
  capture: ScreenCapture;
  targets?: readonly NamedCaptureTarget[];
  pickerRoot?: () => Element | Document;
  class?: string;
}) {
  const state = useScreenCaptureState(props.capture);
  const [target, setTarget] = createSignal<CaptureTarget | undefined>(undefined, {
    ownedWrite: true,
    equals: (a, b) => a?.element === b?.element && a?.label === b?.label && a?.mode === b?.mode,
  });
  const [mode, setMode] = createSignal<CropMode>("region", { ownedWrite: true });
  const [picking, setPicking] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const caps = props.capture.capabilities();
  // Receive controller state at the same external boundary as the status signal; an effect
  // relaying status into these signals would briefly render the previous target.
  onCleanup(
    props.capture.subscribe((value) => {
      if (value.state !== "active" || value.requesting || value.cropping) return;
      const applied = props.capture.target();
      setTarget(applied);
      if (applied) setMode(applied.mode ?? "region");
    }),
  );
  let picker: AbortController | undefined;
  onCleanup(() => picker?.abort());
  const busy = () => state().requesting || state().cropping || picking();
  const run = (operation: () => Promise<unknown>) => {
    setError(undefined);
    void operation().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  const choose = (next: CaptureTarget | undefined) => {
    setError(undefined);
    if (next?.mode === "element") {
      const issue = elementCaptureIssue(next.element);
      if (issue) {
        setError(issue);
        return;
      }
    }
    setTarget(next);
    if (props.capture.stream()) run(() => props.capture.setTarget(next ?? null));
  };
  const pick = async () => {
    picker?.abort();
    const controller = new AbortController();
    picker = controller;
    setPicking(true);
    try {
      const element = await pickCaptureElement({
        root: props.pickerRoot?.(),
        signal: controller.signal,
        mode: mode(),
      });
      if (element && !controller.signal.aborted) choose({ element, mode: mode() });
    } finally {
      if (!controller.signal.aborted) setPicking(false);
    }
  };
  const status = () =>
    state().requesting
      ? "Choose a source to share"
      : state().cropping
        ? "Applying crop…"
        : state().muted
          ? "Capture interrupted"
          : state().crop && !state().crop?.available
            ? "Capture target unavailable"
            : state().state === "active"
              ? "Capturing"
              : state().state === "error"
                ? "Capture unavailable"
                : "Not capturing";
  return (
    <div
      class={`aiui-capture aiui-capture-controls ${props.class ?? ""}`}
      data-screen-capture-ignore=""
    >
      <style>{SCREEN_CAPTURE_STYLES}</style>
      <div class="aiui-capture-row">
        <button
          type="button"
          disabled={!caps.screen || busy()}
          onClick={() => run(() => props.capture.start({ target: target() }))}
        >
          {state().source ? "Change source…" : "Share screen…"}
        </button>
        <button
          type="button"
          disabled={state().state === "idle" && !state().requesting}
          onClick={() => {
            props.capture.stop();
            setError(undefined);
          }}
        >
          Stop
        </button>
        <span role="status">
          <span
            class="aiui-capture-dot"
            data-state={
              state().muted || (state().crop && !state().crop?.available)
                ? "unavailable"
                : state().state
            }
          />
          {status()}
        </span>
      </div>
      <div class="aiui-capture-row">
        <label>
          Capture area
          <select
            aria-label="Capture area"
            disabled={busy()}
            value={target() ? targetLabel(target() as CaptureTarget) : ""}
            onChange={(event) => {
              const found = props.targets?.find((t) => t.label === event.currentTarget.value);
              const element = found?.element();
              if (!event.currentTarget.value) choose(undefined);
              else if (found && element) choose({ element, label: found.label, mode: mode() });
              else setError("That capture target is not currently on the page.");
            }}
          >
            <option value="">Full surface</option>
            <For each={props.targets ?? []}>
              {(item) => (
                <option value={item.label} disabled={!caps[mode()]}>
                  {item.label}
                </option>
              )}
            </For>
            <Show
              when={
                target() &&
                !props.targets?.some(
                  (item) => item.label === targetLabel(target() as CaptureTarget),
                )
              }
            >
              <option value={target() ? targetLabel(target() as CaptureTarget) : ""}>
                {target() ? targetLabel(target() as CaptureTarget) : ""}
              </option>
            </Show>
          </select>
        </label>
        <label>
          Crop mode
          <select
            aria-label="Crop mode"
            value={mode()}
            disabled={busy()}
            onChange={(event) => {
              const next = event.currentTarget.value as CropMode;
              const old = target();
              const issue =
                next === "element" && old ? elementCaptureIssue(old.element) : undefined;
              if (issue) {
                setError(issue);
                event.currentTarget.value = mode();
                return;
              }
              setError(undefined);
              setMode(next);
              if (old) choose({ ...old, mode: next });
            }}
          >
            <option value="region" disabled={!caps.region}>
              Region
            </option>
            <option value="element" disabled={!caps.element}>
              Element only
            </option>
          </select>
        </label>
        <button type="button" disabled={busy() || !caps[mode()]} onClick={() => run(pick)}>
          Pick an element…
        </button>
        <Show when={target()}>
          <button
            type="button"
            disabled={busy()}
            onClick={() =>
              target()?.element.scrollIntoView({
                block: "center",
                inline: "nearest",
                behavior: "instant",
              })
            }
          >
            Show target
          </button>
        </Show>
      </div>
      <p class="aiui-capture-note">
        {target()
          ? "Share this tab and keep the target in view. Region includes overlaps; Element only excludes them."
          : "Full surface captures the whole selected tab, window, or display. Share screen or Change source opens the browser chooser."}
      </p>
      <p class="aiui-capture-note">
        {mode() === "element"
          ? "The picker selects declared capture boundaries, including when you hover over their contents."
          : "The picker selects individual elements. Region captures everything inside their visible rectangle."}
      </p>
      <Show when={!caps.screen}>
        <p class="aiui-capture-note">
          Screen capture needs a supported browser on HTTPS or localhost.
        </p>
      </Show>
      <Show when={!caps.region || !caps.element}>
        <p class="aiui-capture-note">
          {!caps.region && !caps.element
            ? "Element cropping is unavailable in this browser. Full-surface capture remains available."
            : !caps.element
              ? "Element isolation is unavailable in this browser; region cropping is available."
              : "Region cropping is unavailable in this browser; element isolation is available."}
        </p>
      </Show>
      <Show when={state().crop && !state().crop?.available}>
        <p class="aiui-capture-note">{state().crop?.unavailableReason}</p>
      </Show>
      <Show when={error() || state().error}>
        {(text) => (
          <p class="aiui-capture-error" role="alert">
            {text()}
          </p>
        )}
      </Show>
    </div>
  );
}

/** Borrow a stream for a preview. Disposing the view leaves capture ownership with the caller. */
export function ScreenCapturePreview(props: { capture: ScreenCapture; class?: string }) {
  const state = useScreenCaptureState(props.capture);
  const [video, setVideo] = createSignal<HTMLVideoElement | undefined>(undefined, {
    ownedWrite: true,
  });
  const binding = createMemo(
    () => {
      state();
      const target = props.capture.target();
      return {
        video: video(),
        stream: props.capture.stream(),
        target: target?.element,
        mode: target ? (target.mode ?? "region") : undefined,
      };
    },
    {
      equals: (a, b) =>
        a.video === b.video && a.stream === b.stream && a.target === b.target && a.mode === b.mode,
    },
  );
  type Binding = ReturnType<typeof binding>;
  const emptyStats: PreviewStats = { width: 0, height: 0, frames: "waiting" };
  const [measurement, setMeasurement] = createSignal<
    { binding: Binding; stats: PreviewStats } | undefined
  >(undefined, { ownedWrite: true });
  const [blockedBinding, setBlockedBinding] = createSignal<Binding | undefined>(undefined, {
    ownedWrite: true,
  });
  // Old measurements stop matching immediately when the source/crop changes. Resetting a
  // second signal from the binding effect would briefly display stale measurements.
  const stats = () => {
    const value = measurement();
    return value && value.binding === binding() ? value.stats : emptyStats;
  };
  const blocked = () => blockedBinding() === binding();
  let detach = () => {};
  bridgeEffect(binding, (next) => {
    // Refresh the video sink after a native crop change. Chromium can leave an attached
    // video showing the previous crop even after cropTo/restrictTo resolves. Rebinding
    // the same stream restores delivery without reopening capture or stopping tracks.
    detach();
    const element = next.video;
    if (!element) return;
    element.srcObject = next.stream ?? null;
    let valid = true;
    const stop = next.stream
      ? observePreview(element, (stats) => {
          if (valid) setMeasurement({ binding: next, stats });
        })
      : () => {};
    if (next.stream)
      void element.play().catch(() => {
        if (valid) setBlockedBinding(next);
      });
    detach = () => {
      valid = false;
      stop();
      element.pause();
      element.srcObject = null;
    };
  });
  onCleanup(() => detach());
  return (
    <figure
      class={`aiui-capture aiui-capture-preview ${props.class ?? ""}`}
      data-screen-capture-ignore=""
    >
      <style>{SCREEN_CAPTURE_STYLES}</style>
      <div class="aiui-capture-video">
        <video ref={setVideo} muted autoplay playsinline aria-label="Screen capture preview" />
        <Show when={!state().source}>
          <div class="aiui-capture-empty">Your capture preview appears here.</div>
        </Show>
        <Show
          when={
            state().source &&
            !blocked() &&
            (state().crop?.unavailableReason || stats().frames !== "ready")
          }
        >
          <div class="aiui-capture-empty" role="status">
            {state().crop?.unavailableReason ??
              (stats().frames === "empty"
                ? "No preview frames received. Keep the target visible or choose another capture area."
                : "Waiting for captured frames…")}
          </div>
        </Show>
        <Show when={blocked()}>
          <div class="aiui-capture-empty">
            <button
              type="button"
              onClick={() => {
                void video()
                  ?.play()
                  .then(() => setBlockedBinding(undefined))
                  .catch(() => {});
              }}
            >
              Play preview
            </button>
          </div>
        </Show>
      </div>
      <figcaption>
        <span>{state().crop?.label ?? state().source?.label ?? "No source"}</span>
        <Show when={stats().width > 0}>
          <span>
            {stats().width} × {stats().height}
          </span>
        </Show>
        <span>Preview: {stats().fps === undefined ? "—" : stats().fps?.toFixed(1)} fps</span>
      </figcaption>
    </figure>
  );
}

/** Declare a picker boundary with the CSS isolation needed by native Element Capture. */
export function ScreenCaptureTarget(props: {
  children?: JSX.Element;
  ref?: (element: HTMLDivElement) => void;
  class?: string;
  label?: string;
  style?: JSX.CSSProperties;
}) {
  return (
    <div
      ref={props.ref}
      class={props.class}
      data-screen-capture-target=""
      data-capture-label={props.label}
      style={{ ...props.style, ...captureTargetProps().style }}
    >
      {props.children}
    </div>
  );
}
