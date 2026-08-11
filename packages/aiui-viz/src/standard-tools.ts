/**
 * standard-tools.ts — the derived agent interface: the tools every aiui app
 * gets from its declarations, so nobody hand-writes `get-params`/`set-params`
 * boilerplate (the extraction that motivated the control surface — see the
 * front-end controls design notes, git history).
 *
 * From one `registerStandardTools(kit)` call an app's agent surface is
 * ASSEMBLED from the reflection layer — restricted to the KIT'S VIEW of the
 * global registries (its own scope subtree + unscoped declarations, plus any
 * `scopes` the caller declares — see {@link KitView}; the reason: a multi-app
 * document like the gallery must not cross-pollinate kits):
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
import { bridgeRegistry } from "./bridge-effect";
import { cellRegistry } from "./cell";
import { actionByName, controlByName, controlSurface, subscribeControlSurface } from "./control";
import { dependencyEdges } from "./graph-trace";
import type { Scope } from "./scope";

/** How many elements `locate` will describe in one call. */
const LOCATE_LIMIT = 20;

/** Options for {@link registerStandardTools}. */
export interface StandardToolsOptions {
  /**
   * Extra scopes this kit SERVES, beyond its default view (see
   * {@link kitView}) — the composition escape hatch. The twins shape: a kit
   * named `app` hosting slices scoped `left`/`right` declares them here, and
   * their actions surface as `left/kick` / `right/kick`. Accepts Scope objects
   * or bare scope names.
   */
  scopes?: readonly (Scope | string)[];
}

/**
 * The kit's VIEW of the global registries: which declarations belong to it.
 * By default a kit serves its own scope subtree (`ns` or `ns/…`) plus
 * UNSCOPED declarations (a single-app document's common case); `scopes`
 * declares more (composition). A multi-app document (the gallery: N kits,
 * N scopes) is the reason this exists at all — a kit iterating the whole
 * global surface registered every app's actions on every kit (M×N
 * contamination, found live 2026-08-03).
 */
class KitView {
  private readonly prefixes: readonly string[];
  constructor(kit: AgentToolkit, options: StandardToolsOptions | undefined) {
    const declared = (options?.scopes ?? []).map((s) => (typeof s === "string" ? s : s.name));
    this.prefixes = [kit.ns, ...declared];
  }
  /** Does a declaration with this `scope` field belong to the kit? */
  ownsScope(scope: string | undefined): boolean {
    if (scope === undefined) {
      return true; // unscoped declarations belong everywhere
    }
    return this.prefixes.some((p) => scope === p || scope.startsWith(`${p}/`));
  }
  /** Does a registry entry with this (scope-qualified) NAME belong to the
   * kit? Cells carry no scope field in their snapshot — the qualified name
   * is the identity — so ownership reads off the prefix. */
  ownsName(name: string): boolean {
    if (!name.includes("/")) {
      return true; // unqualified = unscoped
    }
    return this.prefixes.some((p) => name.startsWith(`${p}/`));
  }
}

/** The `report` tool's payload for one format — the KIT's view, not the
 * document's: in a multi-app document, aztec's report must not narrate
 * gears' controls. */
function buildReport(
  kit: AgentToolkit,
  view: KitView,
  format: "brief" | "full",
): Record<string, unknown> {
  const surface = controlSurface().filter((e) => view.ownsScope(e.scope));
  const cells = cellRegistry().filter((c) => view.ownsName(c.name));
  const edges = dependencyEdges().filter((e) => view.ownsName(e.cell));
  const bridges = bridgeRegistry().filter((b) => view.ownsName(b.name));

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
      // Airlocks into imperative systems (bridgeEffect): a failed crossing is
      // recorded here rather than thrown, so this line is where it surfaces.
      // Omitted entirely when the app declares no named bridges.
      ...(bridges.length
        ? {
            bridges: Object.fromEntries(
              bridges.map((b) => [
                b.name,
                b.errorCount === 0 ? "ok" : `error×${b.errorCount}: ${b.lastError}`,
              ]),
            ),
          }
        : {}),
      ...custom(kit),
    };
  }
  return {
    controls: surface.filter((e) => e.kind === "control"),
    actions: surface.filter((e) => e.kind === "action"),
    cells,
    edges,
    ...(bridges.length ? { bridges } : {}),
    ...custom(kit),
  };
}

/** The app's own reporter sections (minus ours — they'd double-report). */
function custom(kit: AgentToolkit): Record<string, unknown> {
  const ours = new Set(["cells", "bridges"]);
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

/**
 * An action, dressed as the agent tool it becomes. `toolName` is the action's
 * identity RELATIVE to the kit (see {@link kitRelativeName}); `name` stays the
 * registry's fully-qualified identity, which the run stays late-bound through.
 */
function toolOfAction(name: string, toolName: string): AgentTool | undefined {
  const a = actionByName(name);
  if (!a) return undefined;
  return {
    name: toolName,
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
 * A tool's name inside a kit is its identity relative to that kit. An action's
 * registry name is scope-qualified (`testapp/reseed`), and the shared registry
 * republishes every kit tool under `<ns>/<tool>` — so for the common app shape
 * (kit ns == app scope) keeping the qualified name would double the prefix
 * (`testapp/testapp/reseed` on the channel). Strip the kit's namespace when
 * the action's SCOPE sits inside it; a foreign-scoped action keeps its
 * qualified name, so a kit `app` hosting slices `left`/`right` still exposes
 * distinguishable `app/left/reseed` / `app/right/reseed`.
 */
function kitRelativeName(kit: AgentToolkit, name: string, scope: string | undefined): string {
  if (scope === kit.ns || scope?.startsWith(`${kit.ns}/`)) {
    return name.slice(kit.ns.length + 1);
  }
  return name;
}

/**
 * Register the derived standard tools on a toolkit. Idempotent by name, like
 * every other registration — safe to call from a module that re-evaluates
 * under HMR. Returns an unsubscribe for the control-surface watcher (rarely
 * needed; a page teardown drops everything anyway).
 */
export function registerStandardTools(
  kit: AgentToolkit,
  options?: StandardToolsOptions,
): () => void {
  const view = new KitView(kit, options);
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
    run: (args) => buildReport(kit, view, args?.format === "full" ? "full" : "brief"),
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
      // OWNED controls only — same view as report, so a kit cannot write a
      // sibling app's control in a multi-app document (and the error's
      // control list stays the kit's own, not the document's).
      if (!c || !view.ownsScope(c.scope)) {
        const known = controlSurface()
          .filter((e) => e.kind === "control" && view.ownsScope(e.scope))
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

  // The attribution table: every live named cell OF THIS KIT'S VIEW, its
  // state, and where it is defined — names match the data-cell stamps in the
  // DOM. (Kept as a reporter so handle.report() aggregations and older
  // consumers keep working; the `report` tool above is the format-aware
  // superset.)
  kit.registerReporter("cells", () => cellRegistry().filter((c) => view.ownsName(c.name)));
  // The airlock table: named bridgeEffect crossings and their failure history
  // (a bridge failure is recorded, not thrown — this is where it surfaces).
  kit.registerReporter("bridges", () => bridgeRegistry().filter((b) => view.ownsName(b.name)));

  // ---- actions become real tools, whatever order they were declared in -----
  // OWNED actions only: the control surface is global, the kit's view is not.
  const syncActionTools = () => {
    for (const entry of controlSurface()) {
      if (entry.kind !== "action" || !view.ownsScope(entry.scope)) continue;
      const tool = toolOfAction(entry.name, kitRelativeName(kit, entry.name, entry.scope));
      if (tool) kit.registerTool(tool);
    }
  };
  syncActionTools();
  return subscribeControlSurface(syncActionTools);
}
