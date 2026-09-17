/**
 * Bench.tsx — the instrument every page shares: pick a backend, connect,
 * talk, and READ what happened — captions, the task table with its three
 * timings, the raw ledger, and a composer for sending appends by hand.
 *
 * The session object is recreated when the backend choice changes session
 * CONFIG (hosted ↔ client) and merely re-pointed when it changes only the
 * delegator; either way the page sees one `session()` accessor.
 */

import { LIVE_VOICES, type LiveSession, type LiveState } from "@habemus-papadum/aiui-live";
import {
  LIVE_WIDGET_STYLES,
  LiveCaptions,
  LiveComposer,
  LiveControl,
  LiveKey,
  LiveLedger,
  LiveTasks,
} from "@habemus-papadum/aiui-live/widgets";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import {
  BACKENDS,
  type BackendId,
  type BenchOptions,
  createBenchSession,
  makeDelegator,
} from "./setup";

export interface BenchProps {
  options: BenchOptions;
  backends?: BackendId[];
  initial?: BackendId;
  /** Rendered between the control strip and the tables (page-specific knobs). */
  children?: unknown;
  onSession?: (session: LiveSession) => void;
}

export function Bench(props: BenchProps) {
  const choices = () =>
    BACKENDS.filter((choice) => (props.backends ?? BACKENDS.map((b) => b.id)).includes(choice.id));
  const [backend, setBackend] = createSignal<BackendId>(props.initial ?? "scripted");
  const [voice, setVoice] = createSignal("marin");
  const [serverLog, setServerLog] = createSignal<string[]>([]);
  const options = (): BenchOptions => ({
    ...props.options,
    voice: voice(),
    onLog: (line) => setServerLog((lines) => [...lines.slice(-30), line]),
  });
  const [session, setSession] = createSignal<LiveSession>(
    untrack(() => createBenchSession(backend(), options())),
  );
  const [state, setState] = createSignal<LiveState>(untrack(() => session().state()));
  // Follow whichever session object is current (two-arg createEffect; the
  // subscription is released when the session changes or the bench unmounts).
  // Solid 2: the effect RETURNS its cleanup (run before the next session and
  // on unmount); onCleanup inside an effect body warns NO_OWNER_CLEANUP.
  createEffect(
    () => session(),
    (current) => {
      setState(current.state());
      const unsubscribe = current.onState(setState);
      props.onSession?.(current);
      return unsubscribe;
    },
  );
  onCleanup(() => void session().close());

  const rebuild = () => {
    const previous = session();
    void previous.close();
    previous.currentDelegator()?.dispose?.();
    setSession(createBenchSession(backend(), options()));
  };

  const choose = (id: BackendId) => {
    const wasHosted = backend() === "hosted";
    setBackend(id);
    const isHosted = id === "hosted";
    if (wasHosted !== isHosted || state().status === "live") {
      rebuild();
      return;
    }
    session().currentDelegator()?.dispose?.();
    session().setDelegator(makeDelegator(id, options()));
  };

  const chosen = () => BACKENDS.find((choice) => choice.id === backend());

  return (
    <section class="bench">
      <style>{LIVE_WIDGET_STYLES}</style>
      <div class="bench-row bench-row-head">
        <LiveKey />
        <label class="bench-voice">
          voice
          <select
            value={voice()}
            disabled={state().status === "live" || state().status === "connecting"}
            onChange={(event) => {
              setVoice(event.currentTarget.value);
              rebuild();
            }}
          >
            <For each={LIVE_VOICES}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </label>
      </div>
      <div class="bench-row bench-backends">
        <For each={choices()}>
          {(choice) => (
            <button
              type="button"
              class="bench-backend"
              data-on={String(backend() === choice.id)}
              data-where={choice.where}
              title={choice.blurb}
              onClick={() => choose(choice.id)}
            >
              {choice.label}
            </button>
          )}
        </For>
      </div>
      <p class="bench-blurb">
        <b>{chosen()?.label}</b> · {chosen()?.where} — {chosen()?.blurb}
        <Show when={backend() === "hosted"}>
          {" "}
          (switching to or from hosted mode restarts the session: delegation type is frozen per
          session)
        </Show>
      </p>
      <Show when={session()} keyed>
        {(current) => (
          <>
            <div class="bench-row">
              <LiveControl session={current} />
            </div>
            {props.children as never}
            <LiveCaptions session={current} />
            <div class="bench-row">
              <LiveComposer session={current} />
            </div>
            <h3>tasks</h3>
            <LiveTasks session={current} />
            <Show when={serverLog().length > 0}>
              <h3>relay</h3>
              <pre class="bench-serverlog">{serverLog().join("\n")}</pre>
            </Show>
            <h3>ledger</h3>
            <LiveLedger session={current} />
          </>
        )}
      </Show>
      <details class="bench-fold">
        <summary>session config (as sent)</summary>
        <pre>
          {state().status === "idle"
            ? "(connect to see the composed config)"
            : JSON.stringify(session().sessionConfig(), null, 1)}
        </pre>
      </details>
    </section>
  );
}
