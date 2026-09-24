/**
 * aiui-global.ts — `window.__AIUI__`, installed by the RUNTIME (owner,
 * 2026-07-14): the global exists whether the app runs in dev or production,
 * with no plugin, no ports, and no sockets. It is the page's one visible
 * aiui surface — what the intent client's content script / CDP bootstrap
 * detects (`aiuiSupport`, the `aiui` pill), and where page tools live.
 *
 * The tools half is a REGISTRY, not a bridge: `register(ns, tools)` declares
 * a namespace's full current tool set (replace-by-namespace — HMR-safe, the
 * same contract the old overlay bridge had, so `agentToolkit` forwards
 * unchanged), and the registry is CALLABLE in-page — `list()` and `call()`
 * serve internal clients (an app driving its own tools; no use case today,
 * the door stays open by shape) exactly as they serve the intent client,
 * which subscribes via `onChange` and relays registrations to the channel.
 * The page dials nothing; connectivity arrives from OUTSIDE.
 */

/** One registered page tool (the shape `agentToolkit` forwards). */
export interface AiuiPageTool {
  name: string;
  description: string;
  /** How to use it (see `AgentTool.usage`). */
  usage?: string;
  /** Eagerness class (see `AgentTool.kind`). */
  kind?: "read" | "write";
  inputSchema?: Record<string, unknown>;
  run: (args?: unknown) => unknown;
}

/** Namespace-level registration options. */
export interface AiuiRegisterOptions {
  /** The kit's brief — the text a consumer renders above the tool list. */
  brief?: string;
}

/** One namespace as `list()` reports it. */
export interface AiuiToolsNamespace {
  ns: string;
  tools: AiuiPageTool[];
  active: boolean;
  brief?: string;
}

/** Who called a tool, as the transport that carried the call knows it. */
export interface AiuiCallMeta {
  /** `channel` (Claude Code through `page_tools_call`), `oracle`, `panel`,
   * `live:<delegator>`, `page` (the app itself, or the console)… free-form;
   * each transport names itself. Absent ⇒ `unknown`. */
  caller?: string;
  /** The turn, delegation, or MCP call the call belongs to, when known. */
  ref?: string;
}

/** One recorded call — a row of the on-page call log ({@link AiuiToolsRegistry.calls}). */
export interface AiuiToolCall {
  seq: number;
  /** `Date.now()` when the call started. */
  t: number;
  ns: string;
  tool: string;
  /** The arguments, JSON-clipped like `result`. */
  args?: unknown;
  caller: string;
  ref?: string;
  ok: boolean;
  /** The result, clipped to {@link CALL_RESULT_CAP} bytes of JSON (`{ clipped,
   * bytes, head }` past that) so the log's memory stays bounded. */
  result?: unknown;
  error?: string;
  ms: number;
}

/** How many calls the log keeps (oldest dropped). */
export const CALL_LOG_CAP = 200;
/** JSON bytes of a recorded result/args kept verbatim. */
export const CALL_RESULT_CAP = 4096;

export interface AiuiToolsRegistry {
  /** Declare a namespace's FULL current tool set (replace-by-namespace). The
   * brief is part of the declaration: omitted means none. */
  register(ns: string, tools: AiuiPageTool[], options?: AiuiRegisterOptions): void;
  /** Every namespace's current tools — internal clients and bridges alike.
   * `active` is the namespace's activity bit (see {@link setActive}). */
  list(): AiuiToolsNamespace[];
  /** Invoke one tool by namespace + name. Rejects on unknown. Every call is
   * recorded (see {@link calls}); `meta` names the caller. */
  call(ns: string, name: string, args?: unknown, meta?: AiuiCallMeta): Promise<unknown>;
  /**
   * Record a call that ran OUTSIDE the registry — a projection that executes
   * a control's setter directly (the oracle's control-surface tools) — so the
   * log stays the one complete record of who drove the app.
   */
  record(call: Omit<AiuiToolCall, "seq" | "t"> & { t?: number }): void;
  /** The last {@link CALL_LOG_CAP} calls, oldest first. */
  calls(): AiuiToolCall[];
  /** Fires after every recorded call. Returns the unsubscribe. */
  onCall(handler: (call: AiuiToolCall) => void): () => void;
  /**
   * Flip a namespace's ACTIVITY bit (the page-tools design notes, git history).
   * Default **true** — a standalone app never calls this. A multi-page shell
   * flips it with the SitePage activate/deactivate lifecycle (`toolsNs`); an
   * app with its own client-side routing calls it directly (or through its
   * kit's `setActive`). Consumers choose policy: the coding agent sees every
   * namespace with the flag; the oracle/linter projections filter to active.
   * The bit survives re-registration (HMR re-register must not re-activate a
   * parked page) and may be set BEFORE the namespace registers.
   */
  setActive(ns: string, active: boolean): void;
  /**
   * The debugging enumeration — one row per (namespace, tool), with the
   * namespace's activity riding each row. `console.table`-friendly; the
   * same truth `list()` carries, flattened for eyes.
   */
  ledger(): Array<{
    ns: string;
    tool: string;
    description: string;
    active: boolean;
    kind?: "read" | "write";
    usage?: string;
  }>;
  /** Fires after every `register` AND every activity flip. Returns the
   * unsubscribe. */
  onChange(handler: () => void): () => void;
}

/** The global's shape. `sourceRoot` predates this module: it is the dev-only
 * plugin seed (@habemus-papadum/aiui-source-processor). */
export interface AiuiGlobal {
  v: 1;
  sourceRoot?: string;
  tools?: AiuiToolsRegistry;
  /** DEV-SERVE ONLY: vendor keys the aiui Vite plugin's opt-in `devKeys`
   * option injected (per-provider, e.g. `{ openai: "sk-…" }`). Never present
   * in a production build — the seeding plugin applies to serve alone. */
  devKeys?: Record<string, string>;
  /** Where the aiui Vite plugin's `duckdbAssets` option published the
   * DuckDB-WASM binaries: `<prefix>duckdb-wasm-assets/<version>/…`. Present
   * in builds too (nothing secret) — see aiui-viz/duckdb.ts. */
  duckdbAssets?: { prefix: string; version: string };
  [key: string]: unknown;
}

/** Bound a value's footprint in the log: past the cap, keep a JSON head. */
function clip(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value) ?? "undefined";
  } catch {
    return { unserializable: String(value) };
  }
  if (text.length <= CALL_RESULT_CAP) return value;
  return { clipped: true, bytes: text.length, head: text.slice(0, CALL_RESULT_CAP) };
}

function createRegistry(): AiuiToolsRegistry {
  const byNs = new Map<string, AiuiPageTool[]>();
  const briefs = new Map<string, string>();
  // Parked namespaces, kept SEPARATE from the tool sets so the bit survives
  // re-registration (HMR) and can be set before the namespace registers
  // (route decided, module still lazy-loading). Absence = active.
  const parked = new Set<string>();
  const handlers = new Set<() => void>();
  const notify = (): void => {
    for (const handler of handlers) {
      try {
        handler();
      } catch {
        // one bridge's error must not starve the others
      }
    }
  };
  // The call log: a bounded ring, its own subscribers (a call is not a
  // registration change — the bridges relaying `onChange` must not re-register
  // the namespace on every call).
  const log: AiuiToolCall[] = [];
  let seq = 0;
  const callHandlers = new Set<(call: AiuiToolCall) => void>();
  const record = (entry: Omit<AiuiToolCall, "seq" | "t"> & { t?: number }): void => {
    const call: AiuiToolCall = {
      ...entry,
      seq: ++seq,
      t: entry.t ?? Date.now(),
      ...(entry.args !== undefined ? { args: clip(entry.args) } : {}),
      ...(entry.result !== undefined ? { result: clip(entry.result) } : {}),
    };
    log.push(call);
    if (log.length > CALL_LOG_CAP) log.splice(0, log.length - CALL_LOG_CAP);
    for (const handler of callHandlers) {
      try {
        handler(call);
      } catch {
        // a log viewer's error must not disturb the call
      }
    }
  };
  return {
    register(ns, tools, options) {
      byNs.set(ns, [...tools]);
      if (options?.brief !== undefined) {
        briefs.set(ns, options.brief);
      } else {
        briefs.delete(ns);
      }
      notify();
    },
    list() {
      return [...byNs.entries()].map(([ns, tools]) => {
        const brief = briefs.get(ns);
        return {
          ns,
          tools: [...tools],
          active: !parked.has(ns),
          ...(brief !== undefined ? { brief } : {}),
        };
      });
    },
    async call(ns, name, args, meta) {
      const caller = meta?.caller ?? "unknown";
      const ref = meta?.ref !== undefined ? { ref: meta.ref } : {};
      const tool = byNs.get(ns)?.find((t) => t.name === name);
      if (tool === undefined) {
        const error = `no such page tool: ${ns}.${name}`;
        record({ ns, tool: name, args, caller, ...ref, ok: false, error, ms: 0 });
        throw new Error(error);
      }
      const t0 = Date.now();
      try {
        const result = await tool.run(args);
        record({ ns, tool: name, args, caller, ...ref, ok: true, result, ms: Date.now() - t0 });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        record({ ns, tool: name, args, caller, ...ref, ok: false, error, ms: Date.now() - t0 });
        throw err;
      }
    },
    record,
    calls() {
      return [...log];
    },
    onCall(handler) {
      callHandlers.add(handler);
      return () => callHandlers.delete(handler);
    },
    setActive(ns, active) {
      const changed = parked.has(ns) === active; // parked+activate or live+park
      if (active) {
        parked.delete(ns);
      } else {
        parked.add(ns);
      }
      if (changed) {
        notify();
      }
    },
    ledger() {
      return [...byNs.entries()].flatMap(([ns, tools]) =>
        tools.map((t) => ({
          ns,
          tool: t.name,
          description: t.description,
          active: !parked.has(ns),
          ...(t.kind !== undefined ? { kind: t.kind } : {}),
          ...(t.usage !== undefined ? { usage: t.usage } : {}),
        })),
      );
    },
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

/**
 * Install (or adopt) the global. Idempotent; safe anywhere including SSR
 * (no window → undefined). An EXISTING `tools` surface is respected — adopt,
 * don't clobber (the contract that once let the retired overlay's ws bridge
 * coexist) — but a missing one gets the registry, so production pages carry
 * it by default.
 */
export function ensureAiuiGlobal(): AiuiGlobal | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const w = window as unknown as { __AIUI__?: AiuiGlobal };
  w.__AIUI__ ??= { v: 1 };
  w.__AIUI__.tools ??= createRegistry();
  return w.__AIUI__;
}
