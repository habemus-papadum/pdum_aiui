/**
 * JsonTree: a collapsible JSON widget in the Observable-inspector spirit, but
 * hand-rolled — debug-ui's contract is framework-free and **dependency-free**,
 * and pulling in the real inspector would break it for one widget.
 *
 * Design choices:
 *  - **Native `<details>/<summary>` does the collapsing.** No event wiring, no
 *    open/closed state to track, keyboard toggling for free — the DOM *is* the
 *    state, which also survives the trace view's rebuild-on-update rendering.
 *  - **Collapsed containers stay legible.** A summary reads
 *    `{…} 5 keys a: 1, b: "x…", …` / `[…] 12 items` — the count plus a compact
 *    inline preview of the first few entries, so a closed node tells you
 *    whether it's worth opening. The preview hides once the node is open.
 *  - **Primitives are styled by type** (string / number / boolean / null get
 *    distinct `aiui-dbg-json-*` classes, in styles.ts), and **string leaves run
 *    through the shared absolute-path affordance** (paths.ts) — so attachment
 *    paths inside stage data stay peekable/clickable exactly as they were in
 *    the flat `<pre>` rendering this widget replaces in {@link TraceView}.
 *  - Long strings are truncated only in the inline preview; the expanded leaf
 *    always shows the full text.
 */
import { defaultPreviewUrl, type PreviewUrl, renderPathText } from "./paths";
import { injectDebugUiStyles } from "./styles";

export interface JsonTreeOptions {
  /**
   * Auto-open depth: containers nested shallower than this render expanded.
   * Default 1 — the root open, everything inside collapsed.
   */
  open?: number;
  /**
   * Resolver for absolute image paths inside string leaves (hover-peek /
   * click-open, see paths.ts). Defaults to {@link defaultPreviewUrl}.
   */
  previewUrl?: PreviewUrl;
  /** Document to build in (default `globalThis.document`; for jsdom/tests). */
  document?: Document;
}

/** How many entries a collapsed container's inline preview shows. */
const PREVIEW_ENTRIES = 3;

/** Longest string shown inside an inline preview before truncation. */
const PREVIEW_STRING = 24;

/** What renderNode threads down the recursion. */
interface TreeContext {
  doc: Document;
  open: number;
  previewUrl: PreviewUrl;
  /** The ancestor chain, for cycle safety (trace data is JSON, but never hang). */
  ancestors: WeakSet<object>;
}

/** Render `value` as a collapsible tree rooted in a `.aiui-dbg-json` element. */
export function renderJsonTree(value: unknown, opts: JsonTreeOptions = {}): HTMLElement {
  const doc = opts.document ?? document;
  injectDebugUiStyles(doc);
  const ctx: TreeContext = {
    doc,
    open: opts.open ?? 1,
    previewUrl: opts.previewUrl ?? defaultPreviewUrl,
    ancestors: new WeakSet(),
  };
  const root = doc.createElement("div");
  root.className = "aiui-dbg-json";
  root.append(renderNode(ctx, undefined, value, 0));
  return root;
}

/**
 * One node: a keyed row when `key` is given (an object entry / array index),
 * the bare value otherwise (the root). Containers become a `<details>` whose
 * summary carries the key + mark + count + preview; leaves are a `<div>` row
 * (keyed) or a bare span (root).
 */
function renderNode(
  ctx: TreeContext,
  key: string | undefined,
  value: unknown,
  depth: number,
): HTMLElement {
  const entries = containerEntries(value);
  if (entries !== undefined && ctx.ancestors.has(value as object)) {
    return leafSpan(ctx.doc, "aiui-dbg-json-null", "[circular]");
  }
  if (entries === undefined || entries.list.length === 0) {
    const leaf =
      entries !== undefined
        ? leafSpan(ctx.doc, "aiui-dbg-json-empty", entries.isArray ? "[]" : "{}")
        : renderLeaf(ctx, value);
    if (key === undefined) {
      return leaf;
    }
    const row = ctx.doc.createElement("div");
    row.className = "aiui-dbg-json-row";
    row.append(keySpan(ctx.doc, key), ctx.doc.createTextNode(": "), leaf);
    return row;
  }

  const { list, isArray } = entries;
  const details = ctx.doc.createElement("details");
  details.className = "aiui-dbg-json-node";
  details.open = depth < ctx.open;

  const summary = ctx.doc.createElement("summary");
  summary.className = "aiui-dbg-json-summary";
  if (key !== undefined) {
    summary.append(keySpan(ctx.doc, key), ctx.doc.createTextNode(": "));
  }
  const mark = ctx.doc.createElement("span");
  mark.className = "aiui-dbg-json-mark";
  mark.textContent = isArray ? "[…]" : "{…}";
  const count = ctx.doc.createElement("span");
  count.className = "aiui-dbg-json-count";
  const noun = isArray ? "item" : "key";
  count.textContent = `${list.length} ${noun}${list.length === 1 ? "" : "s"}`;
  const preview = ctx.doc.createElement("span");
  preview.className = "aiui-dbg-json-preview";
  preview.textContent = previewText(list, isArray);
  summary.append(mark, count, preview);

  const children = ctx.doc.createElement("div");
  children.className = "aiui-dbg-json-children";
  ctx.ancestors.add(value as object);
  for (const [k, v] of list) {
    children.append(renderNode(ctx, k, v, depth + 1));
  }
  ctx.ancestors.delete(value as object);

  details.append(summary, children);
  return details;
}

/** A typed primitive leaf; string leaves get the interactive path spans. */
function renderLeaf(ctx: TreeContext, value: unknown): HTMLElement {
  if (typeof value === "string") {
    const span = ctx.doc.createElement("span");
    span.className = "aiui-dbg-json-string";
    span.append(ctx.doc.createTextNode('"'));
    renderPathText(span, value, ctx.previewUrl);
    span.append(ctx.doc.createTextNode('"'));
    return span;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return leafSpan(ctx.doc, "aiui-dbg-json-number", String(value));
  }
  if (typeof value === "boolean") {
    return leafSpan(ctx.doc, "aiui-dbg-json-boolean", String(value));
  }
  if (value === null || value === undefined) {
    return leafSpan(ctx.doc, "aiui-dbg-json-null", String(value));
  }
  // Not JSON (a function, a symbol) — trace data never carries these, but the
  // widget must never break on them either.
  return leafSpan(ctx.doc, "aiui-dbg-json-null", `[${typeof value}]`);
}

/** The entries of a plain object/array, or undefined for anything else. */
function containerEntries(
  value: unknown,
): { list: Array<[string, unknown]>; isArray: boolean } | undefined {
  if (Array.isArray(value)) {
    return { list: value.map((v, i) => [String(i), v]), isArray: true };
  }
  if (typeof value === "object" && value !== null) {
    return { list: Object.entries(value), isArray: false };
  }
  return undefined;
}

/** The compact one-line preview of a collapsed container's first entries. */
function previewText(list: Array<[string, unknown]>, isArray: boolean): string {
  const shown = list
    .slice(0, PREVIEW_ENTRIES)
    .map(([k, v]) => (isArray ? previewValue(v) : `${k}: ${previewValue(v)}`));
  return shown.join(", ") + (list.length > PREVIEW_ENTRIES ? ", …" : "");
}

/** One value inside an inline preview: truncated, never recursive. */
function previewValue(value: unknown): string {
  if (typeof value === "string") {
    const cut = value.length > PREVIEW_STRING ? `${value.slice(0, PREVIEW_STRING)}…` : value;
    return JSON.stringify(cut);
  }
  if (Array.isArray(value)) {
    return "[…]";
  }
  if (typeof value === "object" && value !== null) {
    return "{…}";
  }
  return String(value);
}

function keySpan(doc: Document, key: string): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = "aiui-dbg-json-key";
  span.textContent = key;
  return span;
}

function leafSpan(doc: Document, className: string, text: string): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
