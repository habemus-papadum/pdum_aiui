/**
 * standard-tools.ts — the derived agent interface: the tools every aiui app
 * gets from its declarations, so nobody hand-writes `get-params`/`set-params`
 * boilerplate (the extraction that motivated the control surface — see
 * docs/proposals/front_end_controls_guide_and_more.md).
 *
 * From one `registerStandardTools(kit)` call an app's agent surface is
 * ASSEMBLED from the reflection layer:
 *
 *  - `report` — the whole picture in one call: controls (+values), cells
 *    (+states), actions, dependency edges, plus the app's custom reporter
 *    sections. `format: "brief"` (default) is the token-frugal map view;
 *    `"full"` adds descriptions, definition sites, constraint metadata, and
 *    settledness — everything the registries know.
 *  - `set` — one generic writer for every control, validating through the
 *    control's OWN meta (clamp/snap/enum/type live in control.ts, in one
 *    place). Returns what was written, never a re-read: Solid batches writes,
 *    so a same-tick read would lie.
 *  - **one real tool per `action()`** — each registered verb surfaces under
 *    its own name with its own description and schema (the reason actions
 *    carry descriptions at all). Actions declared AFTER registration are
 *    picked up through the control-surface subscription, so declaration order
 *    never matters.
 *  - `locate` — element → source/cell stamps, unchanged.
 *
 * Kept out of agent-tools.ts so that module stays dependency-free; kept
 * explicit (one line, not automatic) so a headless app can opt out and tests
 * can construct toolkits without a DOM.
 */

import type { AgentTool, AgentToolkit } from "./agent-tools";
import { cellRegistry } from "./cell";
import { actionByName, controlByName, controlSurface, subscribeControlSurface } from "./control";
import { dependencyEdges } from "./graph-trace";

/** How many elements `locate` will describe in one call. */
const LOCATE_LIMIT = 20;

/** The `report` tool's payload for one format. */
function buildReport(kit: AgentToolkit, format: "brief" | "full"): Record<string, unknown> {
  const surface = controlSurface();
  const cells = cellRegistry();
  const edges = dependencyEdges();

  if (format === "brief") {
    return {
      controls: Object.fromEntries(
        surface.filter((e) => e.kind === "control").map((e) => [e.name, e.value]),
      ),
      actions: surface.filter((e) => e.kind === "action").map((e) => e.name),
      cells: Object.fromEntries(cells.map((c) => [c.name, c.state])),
      // "kappa ← profile" reading: which registered nodes each cell's deps read.
      edges: Object.fromEntries(
        edges.map((e) => [e.cell, e.reads.map((r) => `${r.kind}:${r.name}`)]),
      ),
      ...custom(kit),
    };
  }
  return {
    controls: surface.filter((e) => e.kind === "control"),
    actions: surface.filter((e) => e.kind === "action"),
    cells,
    edges,
    ...custom(kit),
  };
}

/** The app's own reporter sections (minus ours — they'd double-report). */
function custom(kit: AgentToolkit): Record<string, unknown> {
  const ours = new Set(["cells"]);
  const out: Record<string, unknown> = {};
  for (const [name, reporter] of kit.handle().reporters) {
    if (ours.has(name)) continue;
    try {
      out[name] = reporter();
    } catch (err) {
      out[name] = { error: String(err) };
    }
  }
  return out;
}

/** An action, dressed as the agent tool it becomes. */
function toolOfAction(name: string): AgentTool | undefined {
  const a = actionByName(name);
  if (!a) return undefined;
  return {
    name: a.name,
    description: a.description ?? `Run the app's "${a.name}" action.`,
    ...(a.params !== undefined ? { params: a.params } : {}),
    ...(a.inputSchema !== undefined ? { inputSchema: a.inputSchema } : {}),
    // Late-bound through the registry so an HMR re-declaration swaps the
    // implementation without re-registering the tool.
    run: (args) => {
      const live = actionByName(name);
      if (!live) throw new Error(`action "${name}" is no longer registered`);
      return live.run(args);
    },
  };
}

/**
 * Register the derived standard tools on a toolkit. Idempotent by name, like
 * every other registration — safe to call from a module that re-evaluates
 * under HMR. Returns an unsubscribe for the control-surface watcher (rarely
 * needed; a page teardown drops everything anyway).
 */
export function registerStandardTools(kit: AgentToolkit): () => void {
  kit.registerTool({
    name: "report",
    description:
      "One bounded snapshot of the whole app, assembled from the reflection registries: " +
      "controls (the writable surface, with values), actions (invocable verbs), cells " +
      "(derived computations, with states), dependency edges (which controls/cells each " +
      "cell's deps read), and the app's custom sections. format: \"brief\" (default, compact " +
      'maps) or "full" (adds descriptions, definition sites file:line, and constraint ' +
      "metadata). Call this FIRST.",
    params: { format: '"brief" (default) | "full"' },
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["brief", "full"] } },
      additionalProperties: false,
    },
    run: (args) => buildReport(kit, args?.format === "full" ? "full" : "brief"),
  });

  kit.registerTool({
    name: "set",
    description:
      "Set one control (the app's writable surface — discover names, current values, and " +
      "constraints via report). The write is validated by the control's own metadata: numbers " +
      "clamp to min/max and snap to step, enums must match an option, wrong types throw. " +
      "Returns the value actually written (never a re-read — writes are batched).",
    params: { name: "control name (see report)", value: "the new value" },
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, value: {} },
      required: ["name", "value"],
      additionalProperties: false,
    },
    run: (args) => {
      const name = String(args?.name ?? "");
      const c = controlByName(name);
      if (!c) {
        const known = controlSurface()
          .filter((e) => e.kind === "control")
          .map((e) => e.name)
          .join(", ");
        throw new Error(`no control "${name}" — controls: ${known || "(none declared)"}`);
      }
      const written = c.set(args?.value as never);
      return { name, value: written };
    },
  });

  kit.registerTool({
    name: "locate",
    description:
      "Map DOM elements to their source locations (compile-time data-source-loc stamps). " +
      "Combine with window.__AIUI__.sourceRoot for absolute paths.",
    params: { selector: `CSS selector; first ${LOCATE_LIMIT} matches returned` },
    run: (args) => {
      const selector = String(args?.selector ?? "*");
      return [...document.querySelectorAll(selector)].slice(0, LOCATE_LIMIT).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 40),
        source: el.closest("[data-source-loc]")?.getAttribute("data-source-loc") ?? null,
        cell: el.closest("[data-cell]")?.getAttribute("data-cell") ?? null,
      }));
    },
  });

  // The attribution table: every live named cell, its state, and where it is
  // defined — names match the data-cell stamps in the DOM. (Kept as a reporter
  // so handle.report() aggregations and older consumers keep working; the
  // `report` tool above is the format-aware superset.)
  kit.registerReporter("cells", () => cellRegistry());

  // ---- actions become real tools, whatever order they were declared in -----
  const syncActionTools = () => {
    for (const entry of controlSurface()) {
      if (entry.kind !== "action") continue;
      const tool = toolOfAction(entry.name);
      if (tool) kit.registerTool(tool);
    }
  };
  syncActionTools();
  return subscribeControlSurface(syncActionTools);
}
