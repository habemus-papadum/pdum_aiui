/**
 * The overlay's own agent tool surface — the intent tool dogfooding the
 * frontend-design methodology it exists to enable (see
 * `docs/guide/frontend-for-agents.md` §"the tool surface"). The overlay *is* a
 * frontend an agent pair-programs against, so it grows the same verbs any
 * instrumented page grows: a bounded `report()`, plus operations registered
 * next to the features they expose. The payoff the methodology promises applies
 * here too — an agent can inspect and reconfigure the intent tool mid-session
 * ("switch my transcriber to mock", "what's the last turn look like?") without
 * the human touching the widget.
 *
 * It registers under the identifier-shaped namespace `aiui_overlay` through the
 * very same bridge that pages use — `window.__AIUI__.tools` (the overlay's own
 * {@link installToolsBridge}) — so it reaches the Claude Code session as the
 * standard `page_tools_list` / `page_tools_call` MCP tools with zero extra
 * plumbing. It also installs a `window.__aiui_overlay` console handle (mirroring
 * aiui-viz's `window.__<ns>` convention) for driving from the devtools console
 * and from the self-verification test.
 *
 * Dependency-free; the tool implementations are supplied by the modality that
 * owns the state ({@link OverlayToolsDeps}), so this module holds only the schema
 * and the registration lifecycle. Registration is best-effort: no bridge (a
 * plain `mountIntentTool`, or an older channel) leaves everything working
 * locally through the returned handle.
 *
 * Deliberately NOT built on aiui-viz's `agentToolkit` (considered in proposal
 * B2.2 and rejected): the two already speak the same bridge, the same ready
 * event, and the same `window.__<ns>` convention — the only real difference
 * is lifecycle. `agentToolkit` adopts its window handle forever (HMR-safe for
 * long-lived notebook pages); the overlay mounts and unmounts inside other
 * people's apps and tests, so it needs `dispose()` to unregister the
 * namespace and drop the handle. Wrapping the toolkit to add that back would
 * share ~30 lines and fork the semantics — dogfood theater, not reuse.
 */
import type { IntentEvent, IntentPipelineConfig } from "./intent-pipeline";
import type { BridgeTool } from "./tools-bridge";

/** The identifier-shaped page namespace the overlay registers under. */
export const OVERLAY_TOOLS_NS = "aiui_overlay";

/** The document event the tools bridge fires once it is installed. */
const READY_EVENT = "aiui:tools-ready";

/** The overlay's thread-socket lifecycle, as reported to the agent. */
export type ThreadSocketState = "none" | "connecting" | "open" | "failed";

/** The bounded, JSON-serializable snapshot `report` returns. Redacts nothing —
 * no secrets live client-side (transcription/correction keys stay in the channel
 * process; the config here is only the client's view). */
export interface OverlayReport {
  armed: boolean;
  mode: string;
  /** The derived UiMode (§B.4): off/ready/composing/shooting/talking/correcting. */
  uiMode: string;
  talking: boolean;
  threadOpen: boolean;
  /** Label of the modality tab currently shown. */
  activeModality: string;
  panelOpen: boolean;
  /** The effective IntentPipelineConfig (DEFAULT ← Vite intent ← panel/agent). */
  config: IntentPipelineConfig;
  events: {
    length: number;
    /** The last ~10 events as types + timestamps only (no payloads). */
    last: Array<{ type: string; at: number }>;
  };
  /** The last status line shown in the panel footer. */
  status: string;
  channel: {
    port: number | undefined;
    threadSocket: ThreadSocketState;
    /** Whether the page→channel tools bridge is installed on this page. */
    bridge: "present" | "absent";
  };
  selection: { present: boolean };
  capture: { grant: "granted" | "none" };
  /**
   * The pen. `strokes` is what is currently drawn on the page — ink outlives
   * the turn it was drawn in, so this is NOT derivable from `events`.
   * `fadeSec` is 0 for permanent ink, else the seconds a stroke takes to
   * vanish.
   */
  ink: { strokes: number; fadeSec: number };
}

/** Result of a `set_config` — mirrors the advanced panel's validate/apply/persist. */
export type SetConfigResult =
  | { ok: true; applied: number; config: IntentPipelineConfig }
  | { ok: false; error: string };

/**
 * The feature-owning implementations the modality supplies. Kept next to the
 * features (the modality holds the engine, the config, the socket); this module
 * only wraps them in schemas and forwards them.
 */
export interface OverlayToolsDeps {
  report(): OverlayReport;
  getConfig(): IntentPipelineConfig;
  /** Validate (through the advanced panel's validator), apply live, persist. */
  setConfig(raw: unknown): SetConfigResult;
  arm(): void;
  disarm(): void;
  openPanel(): void;
  closePanel(): void;
  /** The raw event tail, bounded by `count`. */
  getEvents(count: number): IntentEvent[];
}

/** Handle for local/console/test driving and lifecycle. */
export interface OverlayToolsHandle {
  readonly ns: string;
  readonly tools: BridgeTool[];
  /** Invoke a tool by name (the same path the bridge takes). */
  call(name: string, args?: unknown): unknown;
  report(): OverlayReport;
  /** Re-declare the set (a no-op upstream when schemas are unchanged — by design). */
  reregister(): void;
  dispose(): void;
}

declare global {
  interface Window {
    /** The overlay's own agent surface, for the devtools console (`.report()`). */
    __aiui_overlay?: OverlayToolsHandle;
  }
}

/** A no-argument object schema (draft 2020-12). */
const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

/** Assemble the tool set with real inputSchemas from the feature deps. */
function buildTools(deps: OverlayToolsDeps): BridgeTool[] {
  return [
    {
      name: "report",
      description:
        "Bounded snapshot of the intent overlay: armed/mode/talking/threadOpen, active " +
        "modality, effective config, event-log length + last ~10 event types, last status " +
        "line, channel/thread-socket state, selection + capture-grant presence.",
      inputSchema: NO_ARGS,
      run: () => deps.report(),
    },
    {
      name: "get_config",
      description: "Return the intent tool's effective IntentPipelineConfig (the client's view).",
      inputSchema: NO_ARGS,
      run: () => deps.getConfig(),
    },
    {
      name: "set_config",
      description:
        "Set intent-tool config keys, validated exactly like the advanced panel (unknown keys " +
        'and type mismatches are rejected loudly), applied live, and persisted. e.g. { "config": ' +
        '{ "transcriber": "mock" } }. Merged as a delta over the DEFAULT+Vite base.',
      inputSchema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            description: "Config keys to set (a partial IntentPipelineConfig).",
          },
        },
        required: ["config"],
        additionalProperties: false,
      },
      run: (args) => {
        const config = (args as { config?: unknown } | undefined)?.config;
        const result = deps.setConfig(config);
        if (!result.ok) {
          // Throw so the channel surfaces it as an error result carrying the
          // validator's exact message — the same text the panel shows.
          throw new Error(result.error);
        }
        return result;
      },
    },
    {
      name: "arm",
      description: "Arm the intent tool (as the arm key does). Returns the new report().",
      inputSchema: NO_ARGS,
      run: () => {
        deps.arm();
        return deps.report();
      },
    },
    {
      name: "disarm",
      description: "Disarm the intent tool. Returns the new report().",
      inputSchema: NO_ARGS,
      run: () => {
        deps.disarm();
        return deps.report();
      },
    },
    {
      name: "open_panel",
      description: "Open the intent tool's panel. Returns the new report().",
      inputSchema: NO_ARGS,
      run: () => {
        deps.openPanel();
        return deps.report();
      },
    },
    {
      name: "close_panel",
      description: "Close the intent tool's panel. Returns the new report().",
      inputSchema: NO_ARGS,
      run: () => {
        deps.closePanel();
        return deps.report();
      },
    },
    {
      name: "get_events",
      description:
        "Return the raw tail of the intent event log for debugging a turn (bounded; default 50).",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "How many trailing events to return (default 50).",
          },
        },
        additionalProperties: false,
      },
      run: (args) => {
        const raw = (args as { count?: unknown } | undefined)?.count;
        const count = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 50;
        return deps.getEvents(Math.max(1, Math.min(count, 500)));
      },
    },
  ];
}

/** The tools bridge on this page, if installed (else undefined). */
function bridge():
  | { register(ns: string, tools: BridgeTool[]): void; unregister?(ns: string): void }
  | undefined {
  return typeof window === "undefined" ? undefined : window.__AIUI__?.tools;
}

/**
 * Install the overlay's agent surface. Registers `aiui_overlay` into the tools
 * bridge now (if present) and again on the bridge's ready event (late install),
 * installs a `window.__aiui_overlay` console handle, and returns a handle whose
 * `dispose()` deregisters and cleans up. Safe with no bridge — the returned
 * handle still works locally.
 */
export function installOverlayTools(deps: OverlayToolsDeps): OverlayToolsHandle {
  const tools = buildTools(deps);
  const reregister = (): void => bridge()?.register(OVERLAY_TOOLS_NS, tools);

  const handle: OverlayToolsHandle = {
    ns: OVERLAY_TOOLS_NS,
    tools,
    call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`no overlay tool "${name}" — have: ${tools.map((t) => t.name).join(", ")}`);
      }
      return tool.run(args);
    },
    report: () => deps.report(),
    reregister,
    dispose() {
      if (typeof document !== "undefined") {
        document.removeEventListener(READY_EVENT, onReady);
      }
      // Wire-compatible removal: unregister if the bridge supports it, else the
      // page reload/remount that follows re-declares the namespace anyway.
      bridge()?.unregister?.(OVERLAY_TOOLS_NS);
      if (typeof window !== "undefined" && window.__aiui_overlay === handle) {
        window.__aiui_overlay = undefined;
      }
    },
  };

  const onReady = (): void => reregister();
  if (typeof document !== "undefined") {
    document.addEventListener(READY_EVENT, onReady);
  }
  // Register now in case the bridge is already installed (the Vite mount module
  // installs it before app modules run); the ready listener covers late installs.
  reregister();
  if (typeof window !== "undefined") {
    window.__aiui_overlay = handle;
  }
  return handle;
}
