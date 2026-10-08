/**
 * json-view.tsx — an expandable JSON explorer for the places a tool shows a
 * payload: the tool log's args and results, a ledger entry's event, a session
 * config as sent. Dependency-free, small text, one node per value:
 *
 *  - objects and arrays fold; a fold's summary says what it holds
 *    (`{seed, targetN}`, `[12]`) so a collapsed row still reads;
 *  - small flat objects and arrays stay inline (`{seed: 3065319331, targetN: 32}`)
 *    — an explorer that hides two keys behind a triangle is worse than text;
 *  - long strings clip with a "more" that shows the rest;
 *  - `depth` is how many levels open by default (1: the top level open, its
 *    children folded).
 *
 * Shipped chrome: its one stylesheet reads the `--aiui-*` hooks with neutral
 * fallbacks and is injected once per document (`.aiui-json-*` classes for a
 * consumer that wants more). Its own subpath so pages that never show JSON
 * pay nothing.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

export const JSON_VIEW_STYLES = `
.aiui-json { font: 11px/1.45 var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--aiui-ink, inherit); white-space: pre-wrap; word-break: break-word; }
.aiui-json-row { display: block; padding-left: 1.1em; }
.aiui-json-key { color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-json-str { color: var(--aiui-ink, inherit); }
.aiui-json-num { font-variant-numeric: tabular-nums; }
.aiui-json-bool, .aiui-json-null { color: var(--aiui-ink-muted, inherit); font-style: italic; }
.aiui-json-punct { color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-json-toggle { font: inherit; color: inherit; background: none; border: none; padding: 0;
  cursor: pointer; text-align: left; }
.aiui-json-toggle::before { content: "▸"; display: inline-block; width: 1.1em;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-json-toggle[aria-expanded="true"]::before { content: "▾"; }
.aiui-json-summary { color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-json-more { font: inherit; color: var(--aiui-accent, LinkText); background: none; border: none;
  padding: 0 0.25em; cursor: pointer; }
`;

let stylesInjected = false;

/** The stylesheet goes to <head> once — never into the content, so a reader
 * of the explorer's text (a test, the page-text tool) never sees CSS. */
function ensureStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.textContent = JSON_VIEW_STYLES;
  document.head.append(el);
  stylesInjected = true;
}

/** Strings longer than this clip behind a "more". */
const STRING_CLIP = 160;
/** A flat object/array with at most this many primitive entries stays inline. */
const INLINE_ENTRIES = 4;

function isPrimitive(v: unknown): boolean {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

/** A value that renders as one token: a primitive, or an empty container. */
function isLeaf(v: unknown): boolean {
  return isPrimitive(v) || (typeof v === "object" && v !== null && entriesOf(v).length === 0);
}

function Leaf(props: { value: unknown }): JSX.Element {
  const v = props.value;
  if (typeof v === "object" && v !== null) {
    return <span class="aiui-json-punct">{Array.isArray(v) ? "[]" : "{}"}</span>;
  }
  return <Primitive value={v} />;
}

function Primitive(props: { value: unknown }): JSX.Element {
  const v = props.value;
  if (typeof v === "string") {
    const [all, setAll] = createSignal(false);
    const text = () => (all() || v.length <= STRING_CLIP ? v : `${v.slice(0, STRING_CLIP)}…`);
    return (
      <>
        <span class="aiui-json-str">{JSON.stringify(text())}</span>
        <Show when={v.length > STRING_CLIP && !all()}>
          <button type="button" class="aiui-json-more" onClick={() => setAll(true)}>
            more ({v.length})
          </button>
        </Show>
      </>
    );
  }
  if (typeof v === "number" || typeof v === "bigint") {
    return <span class="aiui-json-num">{String(v)}</span>;
  }
  if (typeof v === "boolean") return <span class="aiui-json-bool">{String(v)}</span>;
  if (v === undefined) return <span class="aiui-json-null">undefined</span>;
  if (typeof v === "function") return <span class="aiui-json-null">ƒ</span>;
  return <span class="aiui-json-null">null</span>;
}

function entriesOf(v: object): Array<[string, unknown]> {
  return Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
}

/** The folded summary: `{seed, targetN}` / `{12 keys}` / `[3]`. */
function summary(v: object, entries: Array<[string, unknown]>): string {
  if (Array.isArray(v)) return `[${entries.length}]`;
  if (entries.length === 0) return "{}";
  if (entries.length <= INLINE_ENTRIES) return `{${entries.map(([k]) => k).join(", ")}}`;
  return `{${entries.length} keys}`;
}

function Node(props: { value: unknown; depth: number; open: number }): JSX.Element {
  const v = props.value;
  if (isPrimitive(v) || typeof v === "function") return <Primitive value={v} />;
  const obj = v as object;
  const entries = entriesOf(obj);
  const isArray = Array.isArray(obj);
  const [open, setOpen] = createSignal(props.depth < props.open);
  const inline = entries.length <= INLINE_ENTRIES && entries.every(([, x]) => isLeaf(x));
  if (entries.length === 0) {
    return <span class="aiui-json-punct">{isArray ? "[]" : "{}"}</span>;
  }
  if (inline) {
    return (
      <span>
        <span class="aiui-json-punct">{isArray ? "[" : "{"}</span>
        <For each={entries}>
          {([k, x], i) => (
            <>
              {i() > 0 ? <span class="aiui-json-punct">, </span> : null}
              {isArray ? null : (
                <>
                  <span class="aiui-json-key">{k}</span>
                  <span class="aiui-json-punct">: </span>
                </>
              )}
              <Leaf value={x} />
            </>
          )}
        </For>
        <span class="aiui-json-punct">{isArray ? "]" : "}"}</span>
      </span>
    );
  }
  return (
    <span>
      <button
        type="button"
        class="aiui-json-toggle"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen(!open())}
      >
        <span class="aiui-json-summary">{summary(obj, entries)}</span>
      </button>
      <Show when={open()}>
        <For each={entries}>
          {([k, x]) => (
            <span class="aiui-json-row">
              <span class="aiui-json-key">{k}</span>
              <span class="aiui-json-punct">: </span>
              <Node value={x} depth={props.depth + 1} open={props.open} />
            </span>
          )}
        </For>
      </Show>
    </span>
  );
}

export interface JsonViewProps {
  value: unknown;
  /** Levels open by default. 1 (the default): the top level open, children folded. */
  depth?: number;
  class?: string;
}

/** The explorer (see the module doc). `undefined` renders as the word. */
export function JsonView(props: JsonViewProps): JSX.Element {
  ensureStyles();
  return (
    <div class={props.class !== undefined ? `aiui-json ${props.class}` : "aiui-json"}>
      <Node value={props.value} depth={0} open={props.depth ?? 1} />
    </div>
  );
}
