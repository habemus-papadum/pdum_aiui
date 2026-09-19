/**
 * agent-tools.ts — the app's tool surface for an agent, WebMCP-flavored.
 *
 * The thesis (see the repo's frontend-for-agents guide): as an app is built,
 * it should accumulate a set of *tools* — named, described, schema'd,
 * invokable operations — that an agent driving the browser can discover and
 * call, exactly as it would call MCP tools. Here that surface is a plain
 * registry installed at `window.__<ns>` — one namespace per notebook page
 * (`__morpho`, `__aztec`, …), so tools from different explorations never
 * collide. Each feature module registers the tools it can honestly support as
 * it is built, so the tool list grows with the app.
 *
 * An agent (via evaluate_script) uses it like:
 *
 *   window.__morpho.tools.map(t => `${t.name}: ${t.description}`)  // discover
 *   window.__morpho.call("set-params", { F: 0.03, k: 0.06 })       // act
 *   window.__morpho.report()                                       // observe
 *
 * Registration is idempotent by name (a re-evaluated module replaces its own
 * tools rather than duplicating them), which makes the registry HMR-safe for
 * free. The `report()` convention comes from the observable-web-workers notes
 * (git history): one bounded, JSON-serializable call for the whole picture.
 *
 * The page also carries a shared registry at `window.__AIUI__.tools`
 * (AiuiToolsRegistry, installed unconditionally by this package's own
 * aiui-global.ts); this module *forwards* its surface there after every
 * mutation, the intent client relays registrations via `onChange`, and the
 * tools appear to the Claude Code session as MCP tools (`page_tools_list` /
 * `page_tools_call`) with calls routing back to the live page functions.
 * Forwarding sends the real, described tools plus one synthetic `report` tool
 * (remote `report()` — the single most useful agent call). It is best-effort:
 * any failure is swallowed so it never disturbs the page.
 */

import { ensureAiuiGlobal } from "./aiui-global";
import type { ToolKind } from "./tool-brief";

export interface AgentTool {
  name: string;
  description: string;
  /**
   * How to use it: when to call it, what the result means, one example.
   * Compiler-lifted from `@usage` / `@example` in an action's doc comment, or
   * explicit. Rendered into a consumer's prompt by `renderToolBrief`; the
   * description stays the one-paragraph "what".
   */
  usage?: string;
  /** Eagerness class for renderers: `read` is called freely once the intent is
   * clear, `write` changes the app. Library-derived tools set it; a custom
   * tool without one is listed under neither class. */
  kind?: ToolKind;
  /** Human/agent-readable parameter description, WebMCP-style (loose schema). */
  params?: Record<string, string>;
  /**
   * Optional real JSON Schema for the arguments (draft 2020-12 object
   * schema). When present it is the source of truth the channel forwards as
   * an MCP tool definition; `params` remains the cheap inline documentation.
   */
  inputSchema?: Record<string, unknown>;
  run: (args?: Record<string, unknown>) => unknown;
}

export interface AgentToolkitHandle {
  tools: AgentTool[];
  call(name: string, args?: Record<string, unknown>): unknown;
  /** One bounded, JSON-serializable snapshot of the whole app. */
  report(): unknown;
  /** Pluggable report sections, registered by feature modules. */
  reporters: Map<string, () => unknown>;
  /** The kit's BRIEF (see {@link AgentToolkitOptions.brief}); shared by every
   * kit object for this namespace, forwarded with every registration. */
  brief?: string;
}

/** Options for {@link agentToolkit}. */
export interface AgentToolkitOptions {
  /**
   * The kit's brief: what the app is, its data model, how its tools relate —
   * the cross-tool text a consumer renders ABOVE the tool list (the oracle's
   * prompt, the live delegation, `page_tools_list`). Purely authored; derived
   * facts (a table list) belong in the relevant tool's `usage`. Re-calling
   * `agentToolkit` with a new brief (HMR) replaces it.
   */
  brief?: string;
}

export interface AgentToolkit {
  /** The toolkit's namespace — the `<ns>` of `window.__<ns>`, and the prefix
   * the shared registry publishes tools under (`<ns>/<tool>`). */
  readonly ns: string;
  /** Register (or replace, by name) one tool. HMR-safe. */
  registerTool(tool: AgentTool): void;
  /** Register (or replace, by name) one section of `report()`. */
  registerReporter(name: string, reporter: () => unknown): void;
  /**
   * Flip this namespace's ACTIVITY bit on the shared registry (see
   * AiuiToolsRegistry.setActive). For apps that drive their own client-side
   * routing; pages mounted by a shell declare `toolsNs` on their SitePage and
   * let the shell flip it.
   */
  setActive(active: boolean): void;
  handle(): AgentToolkitHandle;
}

/**
 * Push the toolkit's current surface to the page's tools registry
 * (`window.__AIUI__.tools` — {@link AiuiToolsRegistry}, installed by
 * aiui-global.ts). Sends only real, described tools, plus a synthetic
 * `report` tool wrapping `report()`. Best-effort: any error is swallowed.
 */
function forwardToRegistry(ns: string, h: AgentToolkitHandle): void {
  try {
    // The global's registry ALWAYS exists (aiui-global.ts — production
    // included, since the 2026-07-14 restructure).
    const bridge = ensureAiuiGlobal()?.tools;
    if (!bridge?.register) {
      return;
    }
    const tools = h.tools
      .filter((t) => typeof t.description === "string" && t.description.length > 0)
      .map((t) => ({
        name: t.name,
        description: t.description,
        ...(t.usage !== undefined ? { usage: t.usage } : {}),
        ...(t.kind !== undefined ? { kind: t.kind } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        run: (args?: unknown) => t.run(args as Record<string, unknown> | undefined),
      }));
    if (!tools.some((t) => t.name === "report")) {
      tools.push({
        name: "report",
        description: "bounded snapshot of page state",
        kind: "read",
        run: () => h.report(),
      });
    }
    // The brief rides as a third argument so an ADOPTED registry from an
    // older bundle (two-argument `register`) still receives the tools.
    bridge.register(ns, tools, h.brief !== undefined ? { brief: h.brief } : undefined);
  } catch {
    // Forwarding is a convenience layered on the local registry; never let it
    // disturb the page (or a windowless test).
  }
}

/** Run a tool and record the outcome on the shared registry's call log as a
 * `page` call. Best-effort: an adopted registry without `record` logs nothing. */
function recordCall(ns: string, tool: string, args: unknown, run: () => unknown): unknown {
  const registry = ensureAiuiGlobal()?.tools;
  const t0 = Date.now();
  const done = (ok: boolean, result?: unknown, error?: string): void => {
    try {
      registry?.record?.({
        ns,
        tool,
        args,
        caller: "page",
        ok,
        ...(ok ? { result } : { error }),
        ms: Date.now() - t0,
      });
    } catch {
      // the log is a convenience; never let it disturb the call
    }
  };
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let out: unknown;
  try {
    out = run();
  } catch (err) {
    done(false, undefined, message(err));
    throw err;
  }
  if (out instanceof Promise) {
    return out.then(
      (value) => {
        done(true, value);
        return value;
      },
      (err: unknown) => {
        done(false, undefined, message(err));
        throw err;
      },
    );
  }
  done(true, out);
  return out;
}

/**
 * Create (or adopt) the tool registry for one notebook namespace: installs
 * `window.__<ns>` on first use. Call once per page module and share the
 * returned toolkit.
 */
export function agentToolkit(ns: string, options?: AgentToolkitOptions): AgentToolkit {
  const key = `__${ns}`;
  const handle = (): AgentToolkitHandle => {
    const w = window as unknown as Record<string, AgentToolkitHandle | undefined>;
    const existing = w[key];
    if (existing) {
      if (options?.brief !== undefined) existing.brief = options.brief;
      return existing;
    }
    {
      const h: AgentToolkitHandle = {
        tools: [],
        reporters: new Map(),
        ...(options?.brief !== undefined ? { brief: options.brief } : {}),
        call(name, args) {
          const tool = h.tools.find((t) => t.name === name);
          if (!tool) {
            const known = h.tools.map((t) => t.name).join(", ");
            throw new Error(`no tool "${name}" — registered tools: ${known}`);
          }
          // A direct call (the app itself, or a developer in the console) is
          // recorded like any other, as `page`, so the log stays complete.
          return recordCall(ns, name, args, () => tool.run(args));
        },
        report() {
          const out: Record<string, unknown> = {};
          for (const [name, reporter] of h.reporters) {
            try {
              out[name] = reporter();
            } catch (err) {
              out[name] = { error: String(err) };
            }
          }
          return out;
        },
      };
      w[key] = h;
      console.info(
        `${ns}: agent tools at window.${key} — .tools (discover), .call(name, args), .report()`,
      );
      return h;
    }
  };

  return {
    ns,
    registerTool(tool: AgentTool): void {
      const h = handle();
      const i = h.tools.findIndex((t) => t.name === tool.name);
      if (i >= 0) h.tools.splice(i, 1, tool);
      else h.tools.push(tool);
      forwardToRegistry(ns, h);
    },
    registerReporter(name: string, reporter: () => unknown): void {
      const h = handle();
      h.reporters.set(name, reporter);
      forwardToRegistry(ns, h);
    },
    setActive(active: boolean): void {
      try {
        // Optional-chained twice over: an ADOPTED registry from an older
        // bundle may predate the activity bit (aiui-global's adopt-don't-
        // clobber contract) — flipping is then a silent no-op, which only
        // costs the projection filter, never the tools.
        ensureAiuiGlobal()?.tools?.setActive?.(ns, active);
      } catch {
        // Activity is a convenience bit; never let it disturb the page.
      }
    },
    handle,
  };
}
