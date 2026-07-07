/**
 * Resolving the realtime submode's `submit_intent` segments into a lowered body.
 *
 * In realtime mode the *model* composes: it emits `submit_intent({ segments })`
 * where each segment is a `text` run, a bare `image` marker (`"shot_3"`), or a
 * bare `selection` marker (`"sel_2"` / `"code_1"`). The channel — which withheld
 * all element/cell metadata and the full selection text from the live model —
 * resolves each marker back to the SAME rendering transcription mode emits (the
 * `<screenshot>` block for shots; the short-inline/long-fenced selection
 * rendering imported from `composeIntent`'s own helpers), and joins the text
 * runs with spaces (exactly `composeIntent`'s join, so a model-composed prompt
 * reads identically to a user-composed one downstream).
 *
 * This module also owns the **injection label grammar** — the compact bracketed
 * text items ({@link selectionInjectionLabel} / {@link selectionRetractionLabel})
 * the processor injects into the live conversation the moment a selection event
 * arrives, mirroring the `[image shot_N]` label rule (RT0 finding 5): the model
 * grounds deictic speech against the clipped excerpt and references the id; the
 * full rendering is re-attached here at resolve time.
 *
 * The shot renderer here **mirrors `renderShot` in the overlay package's
 * `intent-pipeline/engine.ts`** — the source of truth, owned by a sibling.
 * Consolidation (one renderer both sides import) is later work; until then this is
 * a deliberate, small, commented duplicate kept byte-compatible with that source.
 * (The selection renderings are NOT duplicated — engine.ts exports them.)
 * Pure so it is unit-tested directly.
 */
import {
  type LocatedComponent,
  renderAppSelection,
  renderCodeSelection,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";

/** What the channel keeps keyed by a shot's label (never sent to the live model). */
export interface LabelEntry {
  /** Absolute path of the saved shot PNG (the artifact the prompt hands the agent). */
  path?: string;
  /** Located components/cells from the shot event (the withheld metadata). */
  components?: LocatedComponent[];
  /** True for a whole-viewport shot (renders with no element metadata). */
  viewport?: boolean;
}

/**
 * What the channel keeps keyed by a selection's marker (`sel_N` / `code_N`) —
 * the latest event payload under that marker (a superseding re-emit replaces
 * it), never sent to the live model beyond the clipped injection label. A drop
 * marks the entry {@link SelectionEntry.retracted} rather than deleting it, so a
 * model that references a retracted id is caught (and reported) at resolve.
 */
export interface SelectionEntry {
  /** Which selection kind — picks the rendering (app: prose quote; code: fenced). */
  kind: "app" | "code";
  /** The latest payload (the `ComposedItem` subset the shared renderings read). */
  item: {
    text: string;
    sourceLoc?: string;
    cell?: string;
    tex?: string;
    lines?: number;
    url?: string;
  };
  /** Set when a drop retracted this marker — it resolves to nothing. */
  retracted?: boolean;
}

/** Options for {@link resolveSegments} (mirrors the compose's `cwd`/`shotFormat`). */
export interface ResolveOptions {
  cwd?: string;
  shotFormat?: "xml" | "text";
  /** The selection registry (marker → latest payload); absent → no selections. */
  selections?: ReadonlyMap<string, SelectionEntry>;
}

/** The outcome of resolving one `submit_intent` call. */
export interface ResolvedSegments {
  /** The lowered body — text runs and rendered shot/selection blocks joined + trimmed. */
  body: string;
  /** Markers that resolved to a real shot or a carried selection (trace `live resolved`). */
  resolvedMarkers: string[];
  /**
   * Refs that resolved to nothing: an unregistered id (rendered as a visible
   * `— not found`) or a RETRACTED selection (rendered as nothing at all — the
   * human took it back — but still reported here so the trace shows the model
   * referenced it anyway).
   */
  missingRefs: string[];
}

/** Cells listed per element before collapsing (mirrors engine.ts's MAX_CELLS_IN_PROMPT). */
const MAX_CELLS_IN_PROMPT = 4;

/**
 * Resolve a `submit_intent` segments array into the lowered body. Text parts join
 * with spaces; an `image` marker renders as the `<screenshot>` block for its
 * registered shot; a `selection` marker renders as the FULL selection rendering
 * (engine.ts's `renderAppSelection`/`renderCodeSelection` — the same short/long
 * rule `composeIntent` applies). A retracted selection resolves to nothing (the
 * human took it back) and joins `missingRefs`; an unregistered ref renders as a
 * visible `[image|selection <ref> — not found]` (and is reported so the caller
 * can warn in the trace). Marker namespaces are disjoint (`shot_N` vs
 * `sel_N`/`code_N`), so a ref carried in the wrong field (a model that put
 * `sel_2` in `image`) still resolves against whichever registry knows it —
 * forgiving beats fatal.
 */
export function resolveSegments(
  segments: Array<{ text?: string; image?: string; selection?: string }>,
  registry: ReadonlyMap<string, LabelEntry>,
  options: ResolveOptions = {},
): ResolvedSegments {
  const resolvedMarkers: string[] = [];
  const missingRefs: string[] = [];
  const parts: string[] = [];
  const resolveRef = (marker: string, field: "image" | "selection"): void => {
    const shot = registry.get(marker);
    if (shot !== undefined && shot.path !== undefined) {
      resolvedMarkers.push(marker);
      parts.push(renderShotBlock(marker, shot, options));
      return;
    }
    const selection = options.selections?.get(marker);
    if (selection !== undefined) {
      if (selection.retracted === true) {
        // Resolves to NOTHING: the committed prompt honors the retraction even
        // though the conversation couldn't (§4.1) — reported, never rendered.
        missingRefs.push(marker);
        return;
      }
      resolvedMarkers.push(marker);
      parts.push(
        selection.kind === "code"
          ? renderCodeSelection(selection.item)
          : renderAppSelection(selection.item),
      );
      return;
    }
    missingRefs.push(marker);
    parts.push(`[${field} ${marker} — not found]`);
  };
  for (const segment of segments) {
    if (typeof segment.image === "string" && segment.image !== "") {
      resolveRef(segment.image, "image");
    } else if (typeof segment.selection === "string" && segment.selection !== "") {
      resolveRef(segment.selection, "selection");
    } else if (typeof segment.text === "string" && segment.text !== "") {
      parts.push(segment.text);
    }
  }
  // Match composeIntent exactly: join non-empty parts with a space, then trim.
  const body = parts
    .filter((p) => p !== "")
    .join(" ")
    .trim();
  return { body, resolvedMarkers, missingRefs };
}

// ── the injection label grammar (mirrors `[image shot_N]`) ───────────────────

/**
 * How much selection text rides the live injection before clipping. Selections
 * can be arbitrarily long and instructions/context are billed every turn; the
 * clipped excerpt is only there to ground deictic speech ("this gradient") —
 * the FULL text is re-attached at resolve time by {@link resolveSegments}.
 */
export const SELECTION_EXCERPT_CHARS = 160;

/** Clip a selection's text for the injection label, marking the cut honestly. */
function excerptOf(text: string): { excerpt: string; clipped: boolean } {
  const trimmed = text.trim();
  return trimmed.length <= SELECTION_EXCERPT_CHARS
    ? { excerpt: trimmed, clipped: false }
    : { excerpt: `${trimmed.slice(0, SELECTION_EXCERPT_CHARS)}…`, clipped: true };
}

/**
 * The bracketed text item injected into the live conversation when a selection
 * arrives (or re-arrives under the same marker — `updated`). Same grammar family
 * as `[image shot_N]`, so the instructions describe one labeling rule:
 *
 *   `[selection sel_2: "gradient stops" — on-screen selection authored at src/Legend.tsx:41:8]`
 *   `[selection sel_2 updated: "gradient stops and labels" — on-screen selection …]`
 *   `[selection code_1: src/c.ts:12 — 3 lines of code the human contributed: \`…\` (clipped)]`
 *
 * A markerless selection (pre-marker clients) injects without an id — still
 * grounding, just not referenceable. Attribution beyond the locator (cell, TeX)
 * is deliberately withheld here and re-attached at resolve.
 */
export function selectionInjectionLabel(
  marker: string | undefined,
  entry: SelectionEntry,
  updated: boolean,
): string {
  const id = marker !== undefined ? ` ${marker}` : "";
  const phase = updated ? " updated" : "";
  const { excerpt, clipped } = excerptOf(entry.item.text);
  const cut = clipped ? " (clipped)" : "";
  if (entry.kind === "code") {
    const n = entry.item.lines ?? entry.item.text.split("\n").length;
    const where = entry.item.sourceLoc !== undefined ? `${entry.item.sourceLoc} — ` : "";
    const lines = `${n} ${n === 1 ? "line" : "lines"} of code the human contributed`;
    return `[selection${id}${phase}: ${where}${lines}: \`${excerpt}\`${cut}]`;
  }
  const authored = entry.item.sourceLoc !== undefined ? ` authored at ${entry.item.sourceLoc}` : "";
  return `[selection${id}${phase}: "${excerpt}"${cut} — on-screen selection${authored}]`;
}

/**
 * The bracketed retraction item injected when a selection is dropped. The
 * conversation is append-only — the model saw the selection, so the honest move
 * is an explicit "disregard" (exactly the advisory shot retraction, §4.1);
 * {@link resolveSegments} then keeps the retracted id out of the committed body.
 */
export function selectionRetractionLabel(marker: string | undefined): string {
  return marker !== undefined
    ? `[selection ${marker} retracted — disregard it]`
    : "[selection retracted — disregard it]";
}

/**
 * One shot rendered as its inline block — **mirrors `renderShot` in
 * `aiui-dev-overlay/src/intent-pipeline/engine.ts`** (the source of truth). Two
 * styles by `shotFormat`; everything relativized against `cwd`. Kept
 * byte-compatible with that source so a model-composed prompt and a user-composed
 * one render shots identically.
 */
export function renderShotBlock(
  marker: string,
  entry: LabelEntry,
  options: ResolveOptions,
): string {
  return (options.shotFormat ?? "xml") === "xml"
    ? renderShotXml(marker, entry, options.cwd)
    : renderShotText(marker, entry, options.cwd);
}

function renderShotXml(marker: string, entry: LabelEntry, cwd: string | undefined): string {
  const attrs: string[] = [];
  if (entry.path) {
    attrs.push(`path="${escapeXml(relativizePath(entry.path, cwd))}"`);
  } else {
    attrs.push(`marker="${escapeXml(marker)}"`, `missing="image not captured"`);
  }
  if (entry.viewport) {
    attrs.push(`view="full-viewport"`);
    return `<screenshot ${attrs.join(" ")}/>`;
  }
  const components = entry.components ?? [];
  if (components.length === 0) {
    return `<screenshot ${attrs.join(" ")}/>`;
  }
  const lines = components.map((c) => {
    const el: string[] = [`name="${escapeXml(c.component)}"`];
    if (c.source && c.source !== "unknown") {
      el.push(`source="${escapeXml(relativizePath(c.source, cwd))}"`);
    }
    if (c.containment === "within") {
      el.push(`containment="within"`);
    }
    const cells = c.cells ?? [];
    if (cells.length > MAX_CELLS_IN_PROMPT) {
      el.push(`cells-omitted="${cells.length - MAX_CELLS_IN_PROMPT}"`);
    }
    if (cells.length === 0) {
      return `  <element ${el.join(" ")}/>`;
    }
    const kids = cells.slice(0, MAX_CELLS_IN_PROMPT).map((cell) => {
      const src = cell.source ? ` source="${escapeXml(relativizePath(cell.source, cwd))}"` : "";
      return `    <cell name="${escapeXml(cell.name)}"${src}/>`;
    });
    return [`  <element ${el.join(" ")}>`, ...kids, "  </element>"].join("\n");
  });
  return `\n${[`<screenshot ${attrs.join(" ")}>`, ...lines, "</screenshot>"].join("\n")}\n`;
}

function renderShotText(marker: string, entry: LabelEntry, cwd: string | undefined): string {
  const head = entry.path
    ? `[screenshot: ${relativizePath(entry.path, cwd)}`
    : `[screenshot ${marker} — image not captured`;
  if (entry.viewport) {
    return `${head} (full viewport)]`;
  }
  const components = entry.components ?? [];
  if (components.length === 0) {
    return `${head}]`;
  }
  const refs = components.map((c) => {
    const where = c.source && c.source !== "unknown" ? ` @ ${relativizePath(c.source, cwd)}` : "";
    const anchor = c.containment === "within" ? "within " : "";
    let ref = `  ${anchor}${c.component}${where}`;
    const cells = c.cells ?? [];
    if (cells.length > 0) {
      const shown = cells
        .slice(0, MAX_CELLS_IN_PROMPT)
        .map((cell) =>
          cell.source ? `${cell.name} @ ${relativizePath(cell.source, cwd)}` : cell.name,
        );
      const more = cells.length - MAX_CELLS_IN_PROMPT;
      ref += ` — cells: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`;
    }
    return ref;
  });
  return `\n${[head, ...refs, "]"].join("\n")}\n`;
}

/** Relativize a path/source-loc against `cwd` (mirrors engine.ts). */
function relativizePath(path: string, cwd: string | undefined): string {
  if (!cwd) {
    return path;
  }
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** Minimal XML attribute escaping (mirrors engine.ts). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
