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
 * free. The `report()` convention comes from
 * archive/agentic_ui_workflow/agent_observable_web_workers.md: one bounded,
 * JSON-serializable call for the whole picture.
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

export interface AgentTool {
  name: string;
  description: string;
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
}

export interface AgentToolkit {
  /** Register (or replace, by name) one tool. HMR-safe. */
  registerTool(tool: AgentTool): void;
  /** Register (or replace, by name) one section of `report()`. */
  registerReporter(name: string, reporter: () => unknown): void;
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
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        run: (args?: unknown) => t.run(args as Record<string, unknown> | undefined),
      }));
    if (!tools.some((t) => t.name === "report")) {
      tools.push({
        name: "report",
        description: "bounded snapshot of page state",
        run: () => h.report(),
      });
    }
    bridge.register(ns, tools);
  } catch {
    // Forwarding is a convenience layered on the local registry; never let it
    // disturb the page (or a windowless test).
  }
}

/**
 * Create (or adopt) the tool registry for one notebook namespace: installs
 * `window.__<ns>` on first use. Call once per page module and share the
 * returned toolkit.
 */
export function agentToolkit(ns: string): AgentToolkit {
  const key = `__${ns}`;
  const handle = (): AgentToolkitHandle => {
    const w = window as unknown as Record<string, AgentToolkitHandle | undefined>;
    if (!w[key]) {
      const h: AgentToolkitHandle = {
        tools: [],
        reporters: new Map(),
        call(name, args) {
          const tool = h.tools.find((t) => t.name === name);
          if (!tool) {
            const known = h.tools.map((t) => t.name).join(", ");
            throw new Error(`no tool "${name}" — registered tools: ${known}`);
          }
          return tool.run(args);
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
    }
    return w[key] as AgentToolkitHandle;
  };

  return {
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
    handle,
  };
}
