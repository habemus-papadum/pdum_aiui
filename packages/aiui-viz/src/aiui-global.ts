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
  /** Every namespace's current tools — internal clients and bridges alike.
   * `active` is the namespace's activity bit (see {@link setActive}). */
  list(): Array<{ ns: string; tools: AiuiPageTool[]; active: boolean }>;
  /** Invoke one tool by namespace + name. Rejects on unknown. */
  call(ns: string, name: string, args?: unknown): Promise<unknown>;
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
  ledger(): Array<{ ns: string; tool: string; description: string; active: boolean }>;
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
  [key: string]: unknown;
}

function createRegistry(): AiuiToolsRegistry {
  const byNs = new Map<string, AiuiPageTool[]>();
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
  return {
    register(ns, tools) {
      byNs.set(ns, [...tools]);
      notify();
    },
    list() {
      return [...byNs.entries()].map(([ns, tools]) => ({
        ns,
        tools: [...tools],
        active: !parked.has(ns),
      }));
    },
    async call(ns, name, args) {
      const tool = byNs.get(ns)?.find((t) => t.name === name);
      if (tool === undefined) {
        throw new Error(`no such page tool: ${ns}.${name}`);
      }
      return await tool.run(args);
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
