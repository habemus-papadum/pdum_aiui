/**
 * Self-contained styles for the shared debug UI.
 *
 * The panes were prototyped in the retired workbench lab, where the lab's own stylesheet
 * dressed them (`wb-insp-*`). Graduated here, the debug UI must look right in
 * two homes that share no CSS — the intent client's panel and the console's
 * `/__aiui/debug` page — so it ships its own styles under an `aiui-dbg-` prefix
 * and injects them once per document.
 *
 * SHIPPED chrome: every color and face is read through a prefixed `--aiui-*`
 * hook with a neutral fallback (system colors and currentColor mixes), bound
 * once below to local `--dbg-*` names. A host that imports the design system's
 * tokens dresses the debugger in it; any other host gets a quiet, readable
 * default in its own scheme. Status is a word's color on a hairline pill,
 * never a fill; cards are square; nothing casts a shadow.
 */

const STYLE_ID = "aiui-dbg-styles";

/** The hook bindings, applied to every root the debug UI mounts — including
 * the body-attached peeks, which inherit nothing from the pane. */
const HOOKS = /* css */ `
  --dbg-ink: var(--aiui-ink, CanvasText);
  --dbg-ink-muted: var(--aiui-ink-muted, color-mix(in srgb, CanvasText 70%, Canvas));
  --dbg-muted: var(--aiui-muted, color-mix(in srgb, CanvasText 55%, Canvas));
  --dbg-surface: var(--aiui-surface, Canvas);
  --dbg-raised: var(--aiui-surface-raised, color-mix(in srgb, CanvasText 4%, Canvas));
  --dbg-sunken: color-mix(in srgb, var(--dbg-ink) 8%, var(--dbg-surface));
  --dbg-hairline: var(--aiui-hairline, color-mix(in srgb, CanvasText 30%, Canvas));
  --dbg-ghost: var(--aiui-ghost, color-mix(in srgb, CanvasText 14%, Canvas));
  --dbg-accent: var(--aiui-accent, LinkText);
  --dbg-ok: var(--aiui-ok, #2a6e4e);
  --dbg-warn: var(--aiui-warn, #8a5f10);
  --dbg-alarm: var(--aiui-alarm, #9b3b2a);
  --dbg-ok-wash: color-mix(in srgb, var(--dbg-ok) 10%, var(--dbg-surface));
  --dbg-alarm-wash: color-mix(in srgb, var(--dbg-alarm) 8%, var(--dbg-surface));
  --dbg-sans: var(--aiui-sans, ui-sans-serif, system-ui, -apple-system, sans-serif);
  --dbg-mono: var(--aiui-mono, ui-monospace, monospace);
  --dbg-radius: var(--aiui-radius, 0);
`;

export const DEBUG_UI_CSS = /* css */ `
.aiui-dbg, .aiui-dbg-trace, .aiui-dbgt, .aiui-dbgp-head, .aiui-dbg-peek, .aiui-dbg-img-peek {${HOOKS}}
.aiui-dbg { display: flex; flex-direction: column; min-height: 0; flex: 1;
  color: var(--dbg-ink); font: 13px/1.5 var(--dbg-sans); }
.aiui-dbg-tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid var(--dbg-hairline); flex: none; }
.aiui-dbg-tabs button { background: none; border: none; color: var(--dbg-muted); cursor: pointer;
  border-radius: var(--dbg-radius); padding: 3px 10px; font: inherit; }
.aiui-dbg-tabs button:hover { color: var(--dbg-ink); }
.aiui-dbg-tabs button.active { background: var(--dbg-ink); color: var(--dbg-surface); }
.aiui-dbg-tabs .aiui-dbg-export { margin-left: auto; color: var(--dbg-accent); }
.aiui-dbg-pane { flex: 1; overflow-y: auto; padding: 8px 10px; min-height: 0;
  font-family: var(--dbg-mono); font-size: 12px; }
.aiui-dbg-pane[hidden] { display: none; }
.aiui-dbg-ev { padding: 1px 0; color: var(--dbg-ink); white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-ev-thread-open, .aiui-dbg-ev-thread-close { color: var(--dbg-accent); }
.aiui-dbg-ev-transcript-final { color: var(--dbg-ok); }
.aiui-dbg-ev-correction, .aiui-dbg-ev-shot { color: var(--dbg-warn); }
.aiui-dbg-stage { margin-bottom: 12px; }
.aiui-dbg-stage-title { color: var(--dbg-accent); margin-bottom: 3px; }
.aiui-dbg-stage-body { color: var(--dbg-ink); white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-stage-extra { color: var(--dbg-warn); word-break: break-word; }
.aiui-dbg-path { color: var(--dbg-warn); border-bottom: 1px dotted var(--dbg-warn); word-break: break-all; }
.aiui-dbg-path.img { cursor: zoom-in; }
.aiui-dbg-empty { color: var(--dbg-muted); }
.aiui-dbg-peek { position: fixed; z-index: 90; display: none; pointer-events: none;
  background: var(--dbg-raised); border: 1px solid var(--dbg-hairline); border-radius: var(--dbg-radius); padding: 4px; }
.aiui-dbg-peek img { display: block; max-width: 380px; max-height: 280px; border-radius: var(--dbg-radius); }
.aiui-dbg-peek .aiui-dbg-peek-err { color: var(--dbg-muted); font-size: 11px; padding: 4px 6px; }

/* ── trace view: the card-based reading surface (panel + console) ───────────── */
/* The ROOT no longer scrolls: its two sections each own a scroll (below), so
   the prompt stays readable however many stages a trace has. */
.aiui-dbg-trace { flex: 1; overflow: hidden;
  color: var(--dbg-ink); font: 13px/1.5 var(--dbg-sans); }

/* status header — the outcome at a glance, pinned to the top on scroll */
.aiui-dbg-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--dbg-hairline); flex: none;
  background: var(--dbg-raised); z-index: 2; }
.aiui-dbg-outcome { font-weight: 700; font-size: 12px; border-radius: 999px; padding: 1px 10px;
  border: 1px solid currentColor; }
.aiui-dbg-outcome.state-sent { color: var(--dbg-ok); }
.aiui-dbg-outcome.state-cancelled { color: var(--dbg-warn); }
.aiui-dbg-outcome.state-abandoned { color: var(--dbg-muted); }
.aiui-dbg-outcome.state-empty { color: var(--dbg-muted); }
.aiui-dbg-outcome.state-live { color: var(--dbg-accent); }
.aiui-dbg-status-meta { color: var(--dbg-muted); font-size: 12px; }
.aiui-dbg-status-actor { color: var(--dbg-warn); border: 1px solid var(--dbg-warn); border-radius: 999px;
  padding: 0 8px; font-size: 10px; font-weight: 600; }

/* the prompt hero — preamble dimmed, body prominent, screenshots as thumbnails */
/* The trace's two reading surfaces: collapsible, independently scrolling
   (2026-07-12). The flex ratios split the height; a collapsed section keeps
   only its header. */
.aiui-dbg-trace { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.aiui-dbg-sec { display: flex; flex-direction: column; min-height: 0;
  border-bottom: 1px solid var(--dbg-hairline); }
/* Sections are CARDS: a thin border each, so "prompt" and "events" read as
   distinct surfaces (2026-07-12). The prompt owns the height while events are
   collapsed (their default); expanding events splits the pane again. A
   collapsed section shrinks to its header — min-height MUST reset with it or
   the card keeps its floor as dead space (the ghost-gap bug, seen live). */
.aiui-dbg-sec { border: 1px solid var(--dbg-hairline); border-radius: var(--dbg-radius); margin: 4px 10px;
  overflow: hidden; }
.aiui-dbg-sec.prompt { flex: 1 1 auto; min-height: 11rem; }
.aiui-dbg-trace:has(.aiui-dbg-sec.stages:not(.collapsed)) .aiui-dbg-sec.prompt {
  flex: 0 1 auto; max-height: 45%; }
.aiui-dbg-sec.stages { flex: 1 1 auto; }
.aiui-dbg-sec.collapsed { flex: 0 0 auto; max-height: none; min-height: 0; }
.aiui-dbg-sec.collapsed > .aiui-dbg-sec-body { display: none; }
.aiui-dbg-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 5px 12px; background: var(--dbg-raised); border-bottom: 1px solid var(--dbg-ghost); flex: none; }
.aiui-dbg-sec.collapsed .aiui-dbg-sec-head { border-bottom: none; }
.aiui-dbg-sec-toggle { display: inline-flex; align-items: center; gap: 6px;
  background: none; border: none; cursor: pointer; padding: 2px 0;
  color: var(--dbg-muted); font: 600 11px var(--dbg-sans);
  text-transform: uppercase; letter-spacing: 0.12em; }
.aiui-dbg-sec-toggle:hover { color: var(--dbg-ink); }
.aiui-dbg-sec-chevron { transition: transform 120ms; font-size: 17px; line-height: 1;
  color: var(--dbg-muted); }
.aiui-dbg-sec.collapsed .aiui-dbg-sec-chevron { transform: rotate(-90deg); }
.aiui-dbg-sec-body { overflow-y: auto; overflow-x: hidden; min-height: 0; flex: 1 1 auto; }
.aiui-dbg-events-body { display: flex; flex-direction: column; min-height: 0; }
.aiui-dbg-hero { padding: 12px 14px; }
/* The hero is now ONE raw <pre> block; spans style regions inline within it. */
.aiui-dbg-hero-raw { margin: 0; color: var(--dbg-ink); font: 13px/1.6 var(--dbg-mono);
  white-space: pre-wrap; word-break: break-word; }
/* A preamble span: de-emphasized context the agent reads past. */
.aiui-dbg-hero-preamble { color: var(--dbg-muted); }
/* A shot span: its raw [screenshot …] reference (+ metadata block), a hover-preview link to the image. */
.aiui-dbg-hero-shot { color: var(--dbg-ink-muted); }
.aiui-dbg-hero-shot-link { cursor: zoom-in; color: var(--dbg-accent);
  text-decoration: underline; text-decoration-style: dotted; }
.aiui-dbg-hero-body { color: var(--dbg-ink); font: 13px/1.6 var(--dbg-mono);
  white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-hero-none { color: var(--dbg-muted); font-style: italic; }
.aiui-dbg-shot { display: inline-block; vertical-align: top; margin: 4px 6px; }
.aiui-dbg-shot img { display: block; max-width: 100%; border-radius: var(--dbg-radius); border: 1px solid var(--dbg-hairline);
  cursor: zoom-in; }
.aiui-dbg-shot-cap { color: var(--dbg-muted); font: 10px/1.4 var(--dbg-sans); margin-top: 2px; }
.aiui-dbg-shot-missing { color: var(--dbg-muted); font-size: 12px; }

/* filter chips — one direction lane + per-category toggles */
.aiui-dbg-filters { padding: 8px 12px; border-bottom: 1px solid var(--dbg-hairline);
  display: flex; flex-direction: column; gap: 6px; }
.aiui-dbg-filters[hidden] { display: none; }
.aiui-dbg-filter-row { display: flex; gap: 6px; flex-wrap: wrap; }
.aiui-dbg-chip { background: none; border: 1px solid var(--dbg-hairline); color: var(--dbg-muted); cursor: pointer;
  border-radius: 999px; padding: 2px 10px; font: 11px/1.4 var(--dbg-sans); }
.aiui-dbg-chip:hover { color: var(--dbg-ink); }
.aiui-dbg-chip.dir.active { background: var(--dbg-ink); color: var(--dbg-surface); border-color: var(--dbg-ink); }
.aiui-dbg-chip.cat.active { background: var(--dbg-ink); color: var(--dbg-surface); border-color: var(--dbg-ink); }

/* the card list — one card per logical item, coloured by direction */
.aiui-dbg-cards { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.aiui-dbg-card { border: 1px solid var(--dbg-ghost); border-left-width: 3px; border-radius: var(--dbg-radius);
  padding: 6px 10px; background: var(--dbg-raised); }
.aiui-dbg-card.dir-in { border-left-color: var(--dbg-accent); }
.aiui-dbg-card.dir-out { border-left-color: var(--dbg-ok); }
.aiui-dbg-card.dir-agent { border-left-color: var(--dbg-ink); }
.aiui-dbg-card.dir-internal { border-left-color: var(--dbg-warn); }
.aiui-dbg-card.err { border-left-color: var(--dbg-alarm); }
.aiui-dbg-card-head { display: flex; align-items: baseline; gap: 6px; }
.aiui-dbg-card-arrow { color: var(--dbg-muted); font-size: 11px; width: 12px; flex: none; }
.aiui-dbg-card.dir-in .aiui-dbg-card-arrow { color: var(--dbg-accent); }
.aiui-dbg-card.dir-out .aiui-dbg-card-arrow { color: var(--dbg-ok); }
.aiui-dbg-card-icon { font-size: 12px; flex: none; }
.aiui-dbg-card-title { font-weight: 600; color: var(--dbg-ink); font-size: 12px; }
.aiui-dbg-card.err .aiui-dbg-card-title { color: var(--dbg-alarm); }
.aiui-dbg-card-count { margin-left: auto; color: var(--dbg-muted); font-size: 11px; }
.aiui-dbg-card-info { color: var(--dbg-ink); font-size: 12px; margin-top: 3px; word-break: break-word; }
.aiui-dbg-card.err .aiui-dbg-card-info { color: var(--dbg-alarm); }
.aiui-dbg-card-sub { color: var(--dbg-muted); font: 11px/1.5 var(--dbg-mono); margin-top: 3px;
  word-break: break-word; }
.aiui-dbg-card-sub.fix { color: var(--dbg-warn); }
.aiui-dbg-card-img { display: block; max-width: 100%; border-radius: var(--dbg-radius); margin-top: 6px;
  border: 1px solid var(--dbg-hairline); cursor: zoom-in; }
.aiui-dbg-card-audio { display: block; margin-top: 6px; width: 100%; height: 32px; }

/* realtime submode: the submit_intent tool call rendered as prose + shot chips */
.aiui-dbg-live-seg { margin-top: 4px; color: var(--dbg-ink); font: 12px/1.6 var(--dbg-mono);
  white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-live-chip { display: inline-block; vertical-align: baseline; margin: 0 2px;
  padding: 0 6px; border-radius: 999px; background: var(--dbg-surface); border: 1px solid var(--dbg-hairline);
  color: var(--dbg-accent); font-size: 11px; white-space: nowrap; }
/* realtime submode: the saved keyframes of a coalesced video-stream card */
.aiui-dbg-video-thumbs { display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 4px;
  margin-top: 6px; padding-bottom: 4px; scrollbar-width: thin; }
.aiui-dbg-video-more { margin-top: 4px; font: 11px var(--dbg-sans);
  color: var(--dbg-accent); background: none; border: 1px solid var(--dbg-hairline); border-radius: var(--dbg-radius);
  padding: 2px 8px; cursor: pointer; }
.aiui-dbg-img-peek { position: fixed; z-index: 2147483647; max-width: min(720px, 70vw);
  max-height: 60vh; border: 1px solid var(--dbg-hairline); border-radius: var(--dbg-radius);
  background: var(--dbg-raised); pointer-events: none; }
.aiui-dbg-video-thumbs img { max-height: 64px; border-radius: var(--dbg-radius); border: 1px solid var(--dbg-hairline);
  cursor: zoom-in; }

/* streaming-STT partials → an inline word diff (same palette as the patch diff:
   one visual language for "text changed in front of you"). A struck-through run
   on a CUMULATIVE partial means the vendor revised itself — the thing to see. */
.aiui-dbg-diff { margin: 4px 0 0; padding: 5px 7px; background: var(--dbg-sunken); border-radius: var(--dbg-radius);
  font: 11px/1.6 var(--dbg-sans); word-break: break-word; }
.aiui-dbg-diff-same { color: var(--dbg-ink-muted); }
.aiui-dbg-diff-del { color: var(--dbg-alarm); background: var(--dbg-alarm-wash); border-radius: 3px;
  text-decoration: line-through; }
.aiui-dbg-diff-add { color: var(--dbg-ok); background: var(--dbg-ok-wash); border-radius: 3px; }

/* the hero showing a speculative (not-yet-sent) prompt */
.aiui-dbg-hero-preview { margin-bottom: 6px; color: var(--dbg-warn); font-size: 11px;
  text-transform: uppercase; letter-spacing: .12em; }

/* correction patch → a real diff (mirrors the intent client's mm-diff palette) */
.aiui-dbg-patch { margin: 6px 0 0; padding: 6px 8px; background: var(--dbg-sunken); border-radius: var(--dbg-radius);
  font: 11px/1.5 var(--dbg-mono); white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-patch-line { padding: 0 2px; border-radius: 3px; }
.aiui-dbg-patch-line.del { color: var(--dbg-alarm); background: var(--dbg-alarm-wash); }
.aiui-dbg-patch-line.add { color: var(--dbg-ok); background: var(--dbg-ok-wash); }
.aiui-dbg-patch-line.meta, .aiui-dbg-patch-line.hunk { color: var(--dbg-muted); }
.aiui-dbg-patch-line.context { color: var(--dbg-ink-muted); }

/* the collapsed raw disclosure under each card */
.aiui-dbg-card-raw { margin-top: 6px; }
.aiui-dbg-card-raw > summary { cursor: pointer; color: var(--dbg-muted); font-size: 11px; user-select: none; }
.aiui-dbg-card-raw > summary:hover { color: var(--dbg-ink); }
.aiui-dbg-card-raw a { color: var(--dbg-accent); word-break: break-all; }
.aiui-dbg-card-raw > .aiui-dbg-json { margin-top: 4px; }

/* JsonTree (json-tree.ts) — the collapsible stage-data widget */
.aiui-dbg-json { font: 12px/1.6 var(--dbg-mono); word-break: break-word; }
.aiui-dbg-json details { margin: 0; }
.aiui-dbg-json summary.aiui-dbg-json-summary { cursor: pointer; user-select: none; }
.aiui-dbg-json summary.aiui-dbg-json-summary::marker { color: var(--dbg-muted); font-size: 10px; }
.aiui-dbg-json-children { margin-left: 5px; padding-left: 14px; border-left: 1px solid var(--dbg-ghost); }
.aiui-dbg-json-key { color: var(--dbg-accent); }
.aiui-dbg-json-mark { color: var(--dbg-muted); }
.aiui-dbg-json-count { color: var(--dbg-muted); font-size: 11px; margin-left: 6px; }
.aiui-dbg-json-preview { color: var(--dbg-muted); font-size: 11px; margin-left: 8px; }
/* the inline preview earns its keep only while the node is closed */
.aiui-dbg-json details[open] > summary > .aiui-dbg-json-preview { display: none; }
.aiui-dbg-json-string { color: var(--dbg-ok); white-space: pre-wrap; }
.aiui-dbg-json-number { color: var(--dbg-ink); }
.aiui-dbg-json-boolean { color: var(--dbg-warn); }
.aiui-dbg-json-null, .aiui-dbg-json-empty { color: var(--dbg-muted); }

/* ── the traces pane (list + live-followed TraceView; see traces-pane.ts) ── */
.aiui-dbgt { display: flex; flex-direction: column; min-height: 0; flex: 1;
  color: var(--dbg-ink); font: 12px/1.5 var(--dbg-sans); }
.aiui-dbgt-bar { display: flex; align-items: center; gap: 4px; padding: 6px 10px;
  color: var(--dbg-muted); border-bottom: 1px solid var(--dbg-hairline); flex: none; }
.aiui-dbgt-bar label { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; }
/* The picker — a chooser, not the content: a one-line dropdown (trigger +
   popup menu; see traces-pane.ts). */
.aiui-dbgt-list { position: relative; border-bottom: 1px solid var(--dbg-hairline); flex: none; }
.aiui-dbgt-trigger { display: flex; align-items: center; gap: 6px; width: 100%;
  text-align: left; background: transparent; border: none; color: var(--dbg-ink);
  font: inherit; padding: 4px 10px; cursor: pointer; }
.aiui-dbgt-trigger:hover { background: var(--dbg-ghost); }
.aiui-dbgt-caret { margin-left: auto; color: var(--dbg-muted); flex: none; }
.aiui-dbgt-menu { position: absolute; left: 0; right: 0; top: 100%; z-index: 40;
  max-height: 60vh; overflow-y: auto; background: var(--dbg-raised);
  border: 1px solid var(--dbg-hairline); border-top: none; border-radius: 0 0 var(--dbg-radius) var(--dbg-radius); }
.aiui-dbgt-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  background: transparent; border: none; color: var(--dbg-ink); font: inherit; padding: 4px 10px;
  cursor: pointer; }
.aiui-dbgt-row:hover { background: var(--dbg-ghost); }
.aiui-dbgt-row.selected { background: var(--dbg-ink); color: var(--dbg-surface); }
.aiui-dbgt-row.dim { opacity: 0.55; }
.aiui-dbgt-badge { font-size: 10px; color: var(--dbg-muted); border: 1px solid var(--dbg-hairline); border-radius: 999px;
  padding: 0 7px; }
.aiui-dbgt-row.selected .aiui-dbgt-badge { color: inherit; border-color: currentColor; }
.aiui-dbgt-view { flex: 1; overflow-y: auto; padding: 6px 10px; min-height: 0; }
.aiui-dbgt-empty { padding: 16px; color: var(--dbg-muted); }

/* ── the standalone debug page's header (title + channel picker) ── */
.aiui-dbgp-head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; flex: none;
  border-bottom: 1px solid var(--dbg-hairline); background: var(--dbg-raised);
  font: 13px/1.5 var(--dbg-sans); }
.aiui-dbgp-title { color: var(--dbg-ink); font-weight: 600; }
.aiui-dbgp-picker { margin-left: auto; max-width: 46vw; background: var(--dbg-surface); color: var(--dbg-ink);
  border: 1px solid var(--dbg-hairline); border-radius: var(--dbg-radius); padding: 3px 8px; font: inherit; font-size: 12px; }
.aiui-dbgp-picker:disabled { opacity: 0.6; }
`;

/** Inject the debug-UI stylesheet into a document's head, at most once. */
export function injectDebugUiStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = DEBUG_UI_CSS;
  (doc.head ?? doc.documentElement).append(style);
}
