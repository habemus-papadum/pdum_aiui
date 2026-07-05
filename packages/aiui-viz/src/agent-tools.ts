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
 * When the aiui dev overlay is present it installs a tools bridge at
 * `window.__AIUI__.tools`; this module *forwards* its surface there after every
 * mutation, so the tools also appear to the Claude Code session as MCP tools
 * (`page_tools_list` / `page_tools_call`) and calls route back to the live page
 * functions. Forwarding sends the real, described tools plus one synthetic
 * `report` tool (remote `report()` — the single most useful agent call). It is
 * best-effort and dependency-free: with no overlay it does nothing, and any
 * failure is swallowed so it never disturbs the page.
 */

export interface AgentTool {
  name: string;
  description: string;
  /** Human/agent-readable parameter description, WebMCP-style (loose schema). */
  params?: Record<string, string>;
  /**
   * Optional real JSON Schema for the arguments (draft 2020-12 object
   * schema). When present it is the source of truth an overlay/channel can
   * forward as an MCP tool definition; `params` remains the cheap inline
   * documentation. See the overlay handoff (frontend-tool-registry) for the
   * pipeline this feeds.
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
 * The shape the aiui dev overlay installs at `window.__AIUI__.tools` (kept as a
 * local structural type so this module stays dependency-free — it never imports
 * the overlay). `register` declares the full current tool set for a namespace.
 */
interface OverlayToolsBridge {
  register(
    ns: string,
    tools: Array<{
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
      run: (args?: unknown) => unknown;
    }>,
  ): void;
}

/** The document event the overlay fires once its tools bridge is installed. */
const OVERLAY_READY_EVENT = "aiui:tools-ready";

/** Namespaces that already have a one-time "bridge ready" listener wired. */
const readyWired = new Set<string>();

/**
 * Push the toolkit's current surface to the overlay bridge, if one is present.
 * Sends only real, described tools, plus a synthetic `report` tool wrapping
 * `report()`. Best-effort: no overlay → no-op; any error is swallowed.
 */
function forwardToOverlay(ns: string, h: AgentToolkitHandle): void {
  try {
    const bridge =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { __AIUI__?: { tools?: OverlayToolsBridge } }).__AIUI__?.tools;
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
    // disturb the page (or a test that has no overlay).
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

  // The overlay may install its bridge *after* this page has already registered
  // its tools; forward once more when it announces itself. Wired once per ns.
  if (typeof document !== "undefined" && !readyWired.has(ns)) {
    readyWired.add(ns);
    document.addEventListener(OVERLAY_READY_EVENT, () => forwardToOverlay(ns, handle()));
  }

  return {
    registerTool(tool: AgentTool): void {
      const h = handle();
      const i = h.tools.findIndex((t) => t.name === tool.name);
      if (i >= 0) h.tools.splice(i, 1, tool);
      else h.tools.push(tool);
      forwardToOverlay(ns, h);
    },
    registerReporter(name: string, reporter: () => unknown): void {
      const h = handle();
      h.reporters.set(name, reporter);
      forwardToOverlay(ns, h);
    },
    handle,
  };
}
