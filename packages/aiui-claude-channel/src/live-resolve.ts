/**
 * Resolving the realtime submode's `submit_intent` segments into a lowered body.
 *
 * In realtime mode the *model* composes: it emits `submit_intent({ segments })`
 * where each segment is either a `text` run or a bare `image` marker (`"shot_3"`).
 * The channel — which withheld all element/cell metadata from the live model —
 * resolves each marker back to the SAME `<screenshot>` block transcription mode
 * emits, and joins the text runs with spaces (exactly `composeIntent`'s join, so a
 * model-composed prompt reads identically to a user-composed one downstream).
 *
 * The shot renderer here **mirrors `renderShot` in the overlay package's
 * `intent-pipeline/engine.ts`** — the source of truth, owned by a sibling.
 * Consolidation (one renderer both sides import) is later work; until then this is
 * a deliberate, small, commented duplicate kept byte-compatible with that source.
 * Pure and dependency-free so it is unit-tested directly.
 */
import type { LocatedComponent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";

/** What the channel keeps keyed by a shot's label (never sent to the live model). */
export interface LabelEntry {
  /** Absolute path of the saved shot PNG (the artifact the prompt hands the agent). */
  path?: string;
  /** Located components/cells from the shot event (the withheld metadata). */
  components?: LocatedComponent[];
  /** True for a whole-viewport shot (renders with no element metadata). */
  viewport?: boolean;
}

/** Options for {@link resolveSegments} (mirrors the compose's `cwd`/`shotFormat`). */
export interface ResolveOptions {
  cwd?: string;
  shotFormat?: "xml" | "text";
}

/** The outcome of resolving one `submit_intent` call. */
export interface ResolvedSegments {
  /** The lowered body — text runs and rendered shot blocks joined + trimmed. */
  body: string;
  /** Markers that resolved to a real shot (for the trace's `live resolved` stage). */
  resolvedMarkers: string[];
  /** Image refs with no registered shot (rendered as a visible `— not found`). */
  missingRefs: string[];
}

/** Cells listed per element before collapsing (mirrors engine.ts's MAX_CELLS_IN_PROMPT). */
const MAX_CELLS_IN_PROMPT = 4;

/**
 * Resolve a `submit_intent` segments array into the lowered body. Text parts join
 * with spaces; an `image` marker renders as the `<screenshot>` block for its
 * registered shot; an unregistered ref renders as a visible `[image <ref> — not
 * found]` (and is reported so the caller can warn in the trace).
 */
export function resolveSegments(
  segments: Array<{ text?: string; image?: string }>,
  registry: ReadonlyMap<string, LabelEntry>,
  options: ResolveOptions = {},
): ResolvedSegments {
  const resolvedMarkers: string[] = [];
  const missingRefs: string[] = [];
  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment.image === "string" && segment.image !== "") {
      const marker = segment.image;
      const entry = registry.get(marker);
      if (entry !== undefined && entry.path !== undefined) {
        resolvedMarkers.push(marker);
        parts.push(renderShotBlock(marker, entry, options));
      } else {
        missingRefs.push(marker);
        parts.push(`[image ${marker} — not found]`);
      }
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
