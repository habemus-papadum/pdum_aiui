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
  inputSchema?: Record<string, unknown>;
  run: (args?: unknown) => unknown;
}

export interface AiuiToolsRegistry {
  /** Declare a namespace's FULL current tool set (replace-by-namespace). */
  register(ns: string, tools: AiuiPageTool[]): void;
  /** Every namespace's current tools — internal clients and bridges alike. */
  list(): Array<{ ns: string; tools: AiuiPageTool[] }>;
  /** Invoke one tool by namespace + name. Rejects on unknown. */
  call(ns: string, name: string, args?: unknown): Promise<unknown>;
  /** Fires after every `register`. Returns the unsubscribe. */
  onChange(handler: () => void): () => void;
}

/** The global's shape. `frames` and `sourceRoot` predate this module: frames
 * belong to subframe instrumentation, sourceRoot is the dev-only plugin seed. */
export interface AiuiGlobal {
  v: 1;
  frames: unknown[];
  sourceRoot?: string;
  tools?: AiuiToolsRegistry;
  [key: string]: unknown;
}

function createRegistry(): AiuiToolsRegistry {
  const byNs = new Map<string, AiuiPageTool[]>();
  const handlers = new Set<() => void>();
  return {
    register(ns, tools) {
      byNs.set(ns, [...tools]);
      for (const handler of handlers) {
        try {
          handler();
        } catch {
          // one bridge's error must not starve the others
        }
      }
    },
    list() {
      return [...byNs.entries()].map(([ns, tools]) => ({ ns, tools: [...tools] }));
    },
    async call(ns, name, args) {
      const tool = byNs.get(ns)?.find((t) => t.name === name);
      if (tool === undefined) {
        throw new Error(`no such page tool: ${ns}.${name}`);
      }
      return await tool.run(args);
    },
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

/**
 * Install (or adopt) the global. Idempotent; safe anywhere including SSR
 * (no window → undefined). An EXISTING `tools` surface is respected — the
 * old overlay's ws bridge keeps working wherever it is still wired — but a
 * missing one gets the registry, so production pages carry it by default.
 */
export function ensureAiuiGlobal(): AiuiGlobal | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const w = window as unknown as { __AIUI__?: AiuiGlobal };
  w.__AIUI__ ??= { v: 1, frames: [] };
  w.__AIUI__.tools ??= createRegistry();
  return w.__AIUI__;
}
