/**
 * dock.tsx — the voice dock: both voice engines embedded in the page itself,
 * wired to the page's own tools, with viewers and a key field. A pill row in
 * the bottom-right corner (`oracle · live · tools · key`), each
 * opening one pane above it:
 *
 *  - **oracle** — an OpenAI Realtime session (`@habemus-papadum/aiui-oracle`)
 *    with the panel's audio tuning and greeting, the page's kit as its tools
 *    (the `Tools:` section composes from the same projection), the control
 *    strip, the ledger viewer, usage, and the woven prompt as sent;
 *  - **live** — a GPT-Live session (`@habemus-papadum/aiui-live`) and its
 *    delegation backends: a Responses model with the key in this browser,
 *    the vendor-hosted backend, and — when the dev server's live routes
 *    answer — the server's Responses and Claude Code;
 *  - **tools** — the page's ToolLog (calls, inventory, as rendered);
 *  - **key** — one OpenAI key for both engines, pasted into this browser's
 *    localStorage, or the dev server's injected key when there is one.
 *
 * Keys and posture: a pasted key lives in localStorage for this origin and is
 * sent only to api.openai.com by this page — the oracle mints its single-use
 * ephemeral secret in the browser, the live session's broker posts the SDP
 * straight to the vendor. Never to a server of ours. Nothing connects until a
 * pill is pressed; the live session closes itself after two idle minutes,
 * the oracle parks.
 *
 * Multi-app documents (the gallery): only the ACTIVE kits are projected, and
 * the projection follows the registry — a route change re-sends the tools.
 * The dock is agent chrome (`data-aiui-chrome`): `read-page` never reads it.
 */
import {
  backendPrompt,
  browserKey,
  type Delegator,
  devKey,
  LiveSession,
  type LiveTool,
  webRtcTransport as liveWebRtcTransport,
  remoteDelegator,
  responsesDelegator,
  standardBrokers,
} from "@habemus-papadum/aiui-live";
import {
  LIVE_WIDGET_STYLES,
  LiveCaptions,
  LiveControl,
  LiveKey,
  LiveTasks,
  useLiveState,
} from "@habemus-papadum/aiui-live/widgets";
import {
  OracleSession,
  webRtcTransport as oracleWebRtcTransport,
  standardKeySources,
} from "@habemus-papadum/aiui-oracle";
import {
  ORACLE_WIDGET_STYLES,
  OracleControl,
  OracleParkBanner,
  OracleUsage,
  OracleViewer,
} from "@habemus-papadum/aiui-oracle/widgets";
import { ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";
import { ToolLog, toggleToolLog } from "@habemus-papadum/aiui-viz/site/tool-log";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { availableBackends, type DockBackendId, probeServer } from "./backends";
import { type DockSurface, projectSurface } from "./project";
import { DOCK_STYLES } from "./styles";

export interface VoiceDockProps {
  /** An ephemeral-key mint endpoint for the oracle, when the site has one
   * (tried after a pasted key and a dev key). */
  mintUrl?: string;
  /** The live backend's session route; its relay sits beside it. Default
   * `/live/sessions` (what `@habemus-papadum/aiui-live/vite` mounts). */
  serverUrl?: string;
  class?: string;
}

type Pane = "none" | "oracle" | "live" | "key";

const BACKEND_KEY = "aiui.dock.backend";
const GREETING = "Hi there — I'm connected and listening.";

function stored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode, blocked storage: the dock still works, it just forgets.
  }
}

/** What the app IS, for the prompts' `app` slot: the page's title. The kit's
 * brief, which says more, rides with the tools. */
function appLine(): string {
  const title = typeof document !== "undefined" ? document.title.trim() : "";
  return title === "" ? "an aiui app" : title;
}

function createOracle(surface: DockSurface, mintUrl: string | undefined): OracleSession {
  const session = new OracleSession({
    config: {
      // A resolver: the page is named when the session composes, so a tab the
      // user has navigated since the dock mounted is described correctly.
      instructions: () => ({
        app: appLine(),
        context: `The user is looking at "${document.title}" (${location.href}).`,
      }),
      // The intent panel's tuning (a laptop mic beside its own speakers):
      // far-field noise reduction, semantic turn detection at low eagerness,
      // and a disposable greeting that lets the echo canceller converge.
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          turn_detection: { type: "semantic_vad", eagerness: "low" },
        },
      },
      greeting: GREETING,
      tools: surface.tools,
    },
    keySource: standardKeySources(mintUrl !== undefined ? { mintUrl } : {}),
    transport: oracleWebRtcTransport(),
  });
  session.setTools(surface.tools, { brief: surface.brief });
  return session;
}

function makeDelegator(id: DockBackendId, app: string): Delegator | undefined {
  switch (id) {
    case "responses-browser":
      return responsesDelegator({
        key: () => browserKey(),
        app,
        effort: "low",
        model: "gpt-5.4-mini",
      });
    case "responses-server":
      return remoteDelegator({ delegator: "responses" });
    case "claude":
      return remoteDelegator({ delegator: "claude" });
    case "hosted":
      return undefined;
  }
}

function createLive(id: DockBackendId, surface: DockSurface, serverUrl: string): LiveSession {
  const app = appLine();
  const tools = surface.tools as unknown as LiveTool[];
  const session = new LiveSession({
    transport: liveWebRtcTransport({ broker: standardBrokers({ serverUrl }) }),
    config: {
      instructions: { app },
      ...(id === "hosted"
        ? {
            delegation: {
              type: "responses" as const,
              responses: {
                model: "gpt-5.6-terra",
                instructions: backendPrompt({ app }),
                reasoning: { effort: "low" as const },
              },
            },
          }
        : {}),
    },
    delegator: makeDelegator(id, app),
    tools,
    idle: { closeAfterSeconds: 120 },
    progress: { afterMs: 9000 },
  });
  session.setTools(tools, { brief: surface.brief });
  return session;
}

/** The live session's composed config, re-read as its state moves. */
function LiveConfigFold(props: { session: LiveSession }): JSX.Element {
  const state = useLiveState(props.session);
  return (
    <details>
      <summary>session config (as sent)</summary>
      <pre>
        {state().status === "idle"
          ? "(connect to see the composed config)"
          : JSON.stringify(props.session.sessionConfig(), null, 1)}
      </pre>
    </details>
  );
}

let stylesInjected = false;

export function VoiceDock(props: VoiceDockProps): JSX.Element {
  const serverUrl = (): string => props.serverUrl ?? "/live/sessions";
  // Never restored across loads: a pane is only meaningful with the session
  // it shows, and nothing connects until a pill is pressed.
  const [pane, setPane] = createSignal<Pane>("none");
  const [keyPresent, setKeyPresent] = createSignal(browserKey() !== undefined);
  const [server, setServer] = createSignal<boolean | undefined>(undefined);
  void probeServer(serverUrl()).then(setServer);

  // The page's surface, following the registry (route changes park kits).
  const [surface, setSurface] = createSignal<DockSurface>(projectSurface());
  const offChange = ensureAiuiGlobal()?.tools?.onChange(() => {
    const next = projectSurface();
    if (next.signature !== untrack(surface).signature) setSurface(next);
  });
  onCleanup(() => offChange?.());

  // Solid 2 STAGES signal writes: a read in the same handler still sees the
  // old value. The sessions are therefore held in plain variables for the
  // handlers' own bookkeeping, mirrored into signals for the view.

  // ── oracle ────────────────────────────────────────────────────────────────
  let oracleNow: OracleSession | undefined;
  const [oracle, setOracle] = createSignal<OracleSession | undefined>(undefined);
  const [oracleStatus, setOracleStatus] = createSignal("idle");
  const [oraclePrompt, setOraclePrompt] = createSignal("");
  const ensureOracle = (): OracleSession => {
    if (oracleNow !== undefined) return oracleNow;
    const session = createOracle(untrack(surface), props.mintUrl);
    session.onState((s) => setOracleStatus(s.status));
    session.onLedger((entry) => {
      if (entry.kind === "config" && typeof entry.sent?.instructions === "string") {
        setOraclePrompt(entry.sent.instructions);
      }
    });
    oracleNow = session;
    setOracle(session);
    return session;
  };

  // ── live ──────────────────────────────────────────────────────────────────
  const [backend, setBackend] = createSignal<DockBackendId>(
    (stored(BACKEND_KEY) as DockBackendId | undefined) ?? "responses-browser",
  );
  let liveNow: LiveSession | undefined;
  const [live, setLive] = createSignal<LiveSession | undefined>(undefined);
  const [liveStatus, setLiveStatus] = createSignal("idle");
  const dropLive = (): void => {
    const prev = liveNow;
    if (prev === undefined) return;
    liveNow = undefined;
    void prev.close();
    prev.currentDelegator()?.dispose?.();
    setLive(undefined);
    setLiveStatus("idle");
  };
  const ensureLive = (id: DockBackendId): LiveSession => {
    if (liveNow !== undefined) return liveNow;
    const session = createLive(id, untrack(surface), serverUrl());
    session.onState((s) => setLiveStatus(s.status));
    liveNow = session;
    setLive(session);
    return session;
  };
  const chooseBackend = (id: DockBackendId): void => {
    if (id === untrack(backend) && liveNow !== undefined) return;
    setBackend(id);
    store(BACKEND_KEY, id);
    dropLive(); // the delegation TYPE is frozen per session: rebuild, always
    ensureLive(id);
  };

  // Both sessions follow the surface (the compute is tracked, the effect is not).
  createEffect(
    () => surface(),
    (s) => {
      oracleNow?.setTools(s.tools, { brief: s.brief });
      liveNow?.setTools(s.tools as unknown as LiveTool[], { brief: s.brief });
    },
  );

  onCleanup(() => {
    oracleNow?.close();
    dropLive();
  });

  const openPane = (next: Pane): void => {
    setKeyPresent(browserKey() !== undefined);
    const target = untrack(pane) === next ? "none" : next;
    setPane(target);
    if (target === "oracle") ensureOracle();
    if (target === "live") ensureLive(untrack(backend));
  };

  const injectStyles = !stylesInjected;
  stylesInjected = true;

  return (
    <div
      class={`aiui-dock${props.class !== undefined ? ` ${props.class}` : ""}`}
      data-aiui-chrome=""
    >
      {injectStyles ? (
        <style>{DOCK_STYLES + ORACLE_WIDGET_STYLES + LIVE_WIDGET_STYLES}</style>
      ) : null}

      <Show when={pane() === "oracle"}>
        <section class="aiui-dock-pane" aria-label="oracle">
          <Show when={oracle()} keyed>
            {(session) => (
              <>
                <OracleControl session={session} />
                <OracleParkBanner session={session} />
                <OracleViewer session={session} />
                <OracleUsage session={session} />
                <details>
                  <summary>prompt (as sent)</summary>
                  <pre>{oraclePrompt() || "(connect to see the woven instructions)"}</pre>
                </details>
                <p class="aiui-dock-note">
                  tools: {surface().tools.length} from{" "}
                  {surface().namespaces.join(", ") || "no active kit"}
                </p>
              </>
            )}
          </Show>
        </section>
      </Show>

      <Show when={pane() === "live"}>
        <section class="aiui-dock-pane" aria-label="live">
          <h4>backend</h4>
          <div class="aiui-dock-backends">
            <For each={availableBackends({ key: keyPresent(), server: server() === true })}>
              {(a) => (
                <button
                  type="button"
                  class="aiui-dock-backend"
                  data-on={String(backend() === a.backend.id)}
                  disabled={!a.enabled}
                  title={a.why ?? a.backend.blurb}
                  onClick={() => chooseBackend(a.backend.id)}
                >
                  {a.backend.label}
                </button>
              )}
            </For>
          </div>
          <Show when={live()} keyed>
            {(session) => (
              <>
                <LiveControl session={session} />
                <LiveCaptions session={session} />
                <h4>tasks</h4>
                <LiveTasks session={session} />
                <LiveConfigFold session={session} />
                <p class="aiui-dock-note">
                  tools: {surface().tools.length} from{" "}
                  {surface().namespaces.join(", ") || "no active kit"}
                </p>
              </>
            )}
          </Show>
        </section>
      </Show>

      <Show when={pane() === "key"}>
        <section class="aiui-dock-pane" aria-label="key">
          <h4>OpenAI key</h4>
          <LiveKey placeholder="sk-… (used by the oracle and the live session)" />
          <p class="aiui-dock-note">
            {devKey("openai") !== undefined
              ? "A dev key is present (injected by the dev server), so nothing needs pasting here."
              : "No dev key here; paste one to use the oracle or the live session from this page."}
          </p>
          <p class="aiui-dock-note">
            A pasted key stays in this browser's localStorage for this site and is sent only to
            api.openai.com, by this page — never to a server of ours. Clear the field to forget it.
          </p>
        </section>
      </Show>

      <div class="aiui-dock-row">
        <button
          type="button"
          class="aiui-dock-pill"
          aria-pressed={pane() === "oracle" ? "true" : "false"}
          onClick={() => openPane("oracle")}
        >
          <span class="aiui-dock-dot" data-status={oracleStatus()} />
          oracle
        </button>
        <button
          type="button"
          class="aiui-dock-pill"
          aria-pressed={pane() === "live" ? "true" : "false"}
          onClick={() => openPane("live")}
        >
          <span class="aiui-dock-dot" data-status={liveStatus()} />
          live
        </button>
        <button
          type="button"
          class="aiui-dock-pill"
          onClick={() => {
            toggleToolLog();
            setPane("none");
          }}
        >
          tools
        </button>
        <button
          type="button"
          class="aiui-dock-pill"
          aria-pressed={pane() === "key" ? "true" : "false"}
          onClick={() => openPane("key")}
        >
          key
        </button>
      </div>
      <ToolLog />
    </div>
  );
}
