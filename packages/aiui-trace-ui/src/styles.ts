/**
 * Self-contained styles for the shared debug UI.
 *
 * The panes were prototyped in the retired workbench lab, where the lab's own stylesheet
 * dressed them (`wb-insp-*`). Graduated here, the debug UI must look right in
 * two homes that share no CSS — the intent client's panel and the console's
 * `/__aiui/debug` page — so it ships its own styles under an `aiui-dbg-` prefix
 * and injects them once per document. One palette in both, so an embedded pane
 * is visually of a piece with the standalone trace debugger.
 */

const STYLE_ID = "aiui-dbg-styles";

export const DEBUG_UI_CSS = /* css */ `
.aiui-dbg { display: flex; flex-direction: column; min-height: 0; flex: 1;
  color: #e8e8ea; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.aiui-dbg-tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid #262c3a; flex: none; }
.aiui-dbg-tabs button { background: none; border: none; color: #9aa0aa; cursor: pointer;
  border-radius: 6px; padding: 3px 10px; font: inherit; }
.aiui-dbg-tabs button:hover { color: #e8e8ea; }
.aiui-dbg-tabs button.active { background: #232936; color: #e8e8ea; }
.aiui-dbg-tabs .aiui-dbg-export { margin-left: auto; color: #8ab4f8; }
.aiui-dbg-pane { flex: 1; overflow-y: auto; padding: 8px 10px; min-height: 0;
  font-family: ui-monospace, monospace; font-size: 12px; }
.aiui-dbg-pane[hidden] { display: none; }
.aiui-dbg-ev { padding: 1px 0; color: #cfd3da; white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-ev-thread-open, .aiui-dbg-ev-thread-close { color: #8ab4f8; }
.aiui-dbg-ev-transcript-final { color: #7ee0a3; }
.aiui-dbg-ev-correction, .aiui-dbg-ev-shot { color: #ffd166; }
.aiui-dbg-stage { margin-bottom: 12px; }
.aiui-dbg-stage-title { color: #8ab4f8; margin-bottom: 3px; }
.aiui-dbg-stage-body { color: #e8e8ea; white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-stage-extra { color: #ffd166; word-break: break-word; }
.aiui-dbg-path { color: #ffd166; border-bottom: 1px dotted #ffd16688; word-break: break-all; }
.aiui-dbg-path.img { cursor: zoom-in; }
.aiui-dbg-empty { color: #9aa0aa; }
.aiui-dbg-peek { position: fixed; z-index: 90; display: none; pointer-events: none;
  background: #1f2430; border: 1px solid #3a4152; border-radius: 8px; padding: 4px;
  box-shadow: 0 8px 30px #0009; }
.aiui-dbg-peek img { display: block; max-width: 380px; max-height: 280px; border-radius: 5px; }
.aiui-dbg-peek .aiui-dbg-peek-err { color: #9aa0aa; font-size: 11px; padding: 4px 6px; }

/* ── trace view: the card-based reading surface (panel + console) ───────────── */
/* The ROOT no longer scrolls: its two sections each own a scroll (below), so
   the prompt stays readable however many stages a trace has. */
.aiui-dbg-trace { flex: 1; overflow: hidden;
  color: #e8e8ea; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }

/* status header — the outcome at a glance, pinned to the top on scroll */
.aiui-dbg-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid #262c3a; flex: none;
  background: #14171f; z-index: 2; }
.aiui-dbg-outcome { font-weight: 700; font-size: 12px; border-radius: 999px; padding: 1px 10px; }
.aiui-dbg-outcome.state-sent { color: #7ee0a3; background: #7ee0a31a; }
.aiui-dbg-outcome.state-cancelled { color: #ffd166; background: #ffd1661a; }
.aiui-dbg-outcome.state-abandoned { color: #9aa0aa; background: #9aa0aa1a; }
.aiui-dbg-outcome.state-empty { color: #9aa0aa; background: #9aa0aa1a; }
.aiui-dbg-outcome.state-live { color: #8ab4f8; background: #8ab4f81a; }
.aiui-dbg-status-meta { color: #9aa0aa; font-size: 12px; }
.aiui-dbg-status-actor { color: #ffd166; border: 1px solid #3a2f14; border-radius: 999px;
  padding: 0 8px; font-size: 10px; font-weight: 600; }

/* the prompt hero — preamble dimmed, body prominent, screenshots as thumbnails */
/* The trace's two reading surfaces: collapsible, independently scrolling
   (2026-07-12). The flex ratios split the height; a collapsed section keeps
   only its header. */
.aiui-dbg-trace { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.aiui-dbg-sec { display: flex; flex-direction: column; min-height: 0;
  border-bottom: 1px solid #262c3a; }
/* Sections are CARDS: a thin border each, so "prompt" and "events" read as
   distinct surfaces (2026-07-12). The prompt owns the height while events are
   collapsed (their default); expanding events splits the pane again. A
   collapsed section shrinks to its header — min-height MUST reset with it or
   the card keeps its floor as dead space (the ghost-gap bug, seen live). */
.aiui-dbg-sec { border: 1px solid #262c3a; border-radius: 8px; margin: 4px 10px;
  overflow: hidden; }
.aiui-dbg-sec.prompt { flex: 1 1 auto; min-height: 11rem; }
.aiui-dbg-trace:has(.aiui-dbg-sec.stages:not(.collapsed)) .aiui-dbg-sec.prompt {
  flex: 0 1 auto; max-height: 45%; }
.aiui-dbg-sec.stages { flex: 1 1 auto; }
.aiui-dbg-sec.collapsed { flex: 0 0 auto; max-height: none; min-height: 0; }
.aiui-dbg-sec.collapsed > .aiui-dbg-sec-body { display: none; }
.aiui-dbg-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 5px 12px; background: #12151c; border-bottom: 1px solid #1c2029; flex: none; }
.aiui-dbg-sec.collapsed .aiui-dbg-sec-head { border-bottom: none; }
.aiui-dbg-sec-toggle { display: inline-flex; align-items: center; gap: 6px;
  background: none; border: none; cursor: pointer; padding: 2px 0;
  color: #9aa0aa; font: 600 11px ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase; letter-spacing: 0.04em; }
.aiui-dbg-sec-toggle:hover { color: #e8e8ea; }
.aiui-dbg-sec-chevron { transition: transform 120ms; font-size: 17px; line-height: 1;
  color: #8ab4f8; }
.aiui-dbg-sec.collapsed .aiui-dbg-sec-chevron { transform: rotate(-90deg); }
.aiui-dbg-sec-body { overflow-y: auto; overflow-x: hidden; min-height: 0; flex: 1 1 auto; }
.aiui-dbg-events-body { display: flex; flex-direction: column; min-height: 0; }
.aiui-dbg-hero { padding: 12px 14px; }
/* The hero is now ONE raw <pre> block; spans style regions inline within it. */
.aiui-dbg-hero-raw { margin: 0; color: #e8e8ea; font: 13px/1.6 ui-monospace, monospace;
  white-space: pre-wrap; word-break: break-word; }
/* A preamble span: de-emphasized context the agent reads past. */
.aiui-dbg-hero-preamble { color: #6f7686; }
/* A shot span: its raw [screenshot …] reference (+ metadata block), a hover-preview link to the image. */
.aiui-dbg-hero-shot { color: #cdd3e0; }
.aiui-dbg-hero-shot-link { cursor: zoom-in; color: #8ab4f8;
  text-decoration: underline; text-decoration-style: dotted; }
.aiui-dbg-hero-body { color: #e8e8ea; font: 13px/1.6 ui-monospace, monospace;
  white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-hero-none { color: #9aa0aa; font-style: italic; }
.aiui-dbg-shot { display: inline-block; vertical-align: top; margin: 4px 6px; }
.aiui-dbg-shot img { display: block; max-width: 100%; border-radius: 6px; border: 1px solid #2a3140;
  cursor: zoom-in; }
.aiui-dbg-shot-cap { color: #9aa0aa; font: 10px/1.4 ui-sans-serif, system-ui; margin-top: 2px; }
.aiui-dbg-shot-missing { color: #9aa0aa; font-size: 12px; }

/* filter chips — one direction lane + per-category toggles */
.aiui-dbg-filters { padding: 8px 12px; border-bottom: 1px solid #262c3a;
  display: flex; flex-direction: column; gap: 6px; }
.aiui-dbg-filters[hidden] { display: none; }
.aiui-dbg-filter-row { display: flex; gap: 6px; flex-wrap: wrap; }
.aiui-dbg-chip { background: none; border: 1px solid #2a3140; color: #9aa0aa; cursor: pointer;
  border-radius: 999px; padding: 2px 10px; font: 11px/1.4 ui-sans-serif, system-ui; }
.aiui-dbg-chip:hover { color: #e8e8ea; }
.aiui-dbg-chip.dir.active { background: #232936; color: #e8e8ea; border-color: #3a4152; }
.aiui-dbg-chip.cat.active { color: #e8e8ea; border-color: #3a4152; background: #1b2130; }

/* the card list — one card per logical item, coloured by direction */
.aiui-dbg-cards { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.aiui-dbg-card { border: 1px solid #2a3140; border-left-width: 3px; border-radius: 8px;
  padding: 6px 10px; background: #171b25; }
.aiui-dbg-card.dir-in { border-left-color: #8ab4f8; }
.aiui-dbg-card.dir-out { border-left-color: #7ee0a3; }
.aiui-dbg-card.dir-agent { border-left-color: #c58af9; }
.aiui-dbg-card.dir-internal { border-left-color: #ffd166; }
.aiui-dbg-card.err { border-left-color: #f28b82; }
.aiui-dbg-card-head { display: flex; align-items: baseline; gap: 6px; }
.aiui-dbg-card-arrow { color: #6f7686; font-size: 11px; width: 12px; flex: none; }
.aiui-dbg-card.dir-in .aiui-dbg-card-arrow { color: #8ab4f8; }
.aiui-dbg-card.dir-out .aiui-dbg-card-arrow { color: #7ee0a3; }
.aiui-dbg-card-icon { font-size: 12px; flex: none; }
.aiui-dbg-card-title { font-weight: 600; color: #e8e8ea; font-size: 12px; }
.aiui-dbg-card.err .aiui-dbg-card-title { color: #f28b82; }
.aiui-dbg-card-count { margin-left: auto; color: #9aa0aa; font-size: 11px; }
.aiui-dbg-card-info { color: #cfd3da; font-size: 12px; margin-top: 3px; word-break: break-word; }
.aiui-dbg-card.err .aiui-dbg-card-info { color: #f2b8b3; }
.aiui-dbg-card-sub { color: #9aa0aa; font: 11px/1.5 ui-monospace, monospace; margin-top: 3px;
  word-break: break-word; }
.aiui-dbg-card-sub.fix { color: #ffd166; }
.aiui-dbg-card-img { display: block; max-width: 100%; border-radius: 6px; margin-top: 6px;
  border: 1px solid #2a3140; cursor: zoom-in; }
.aiui-dbg-card-audio { display: block; margin-top: 6px; width: 100%; height: 32px; }

/* realtime submode: the submit_intent tool call rendered as prose + shot chips */
.aiui-dbg-live-seg { margin-top: 4px; color: #e8e8ea; font: 12px/1.6 ui-monospace, monospace;
  white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-live-chip { display: inline-block; vertical-align: baseline; margin: 0 2px;
  padding: 0 6px; border-radius: 999px; background: #1b2130; border: 1px solid #3a4152;
  color: #c58af9; font-size: 11px; white-space: nowrap; }
/* realtime submode: the saved keyframes of a coalesced video-stream card */
.aiui-dbg-video-thumbs { display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 4px;
  margin-top: 6px; padding-bottom: 4px; scrollbar-width: thin; }
.aiui-dbg-video-more { margin-top: 4px; font: 11px ui-sans-serif, system-ui, sans-serif;
  color: #8ab4f8; background: none; border: 1px solid #3a4152; border-radius: 4px;
  padding: 2px 8px; cursor: pointer; }
.aiui-dbg-peek { position: fixed; z-index: 2147483647; max-width: min(720px, 70vw);
  max-height: 60vh; border: 1px solid #3a4152; border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.55); background: #14161d; pointer-events: none; }
.aiui-dbg-video-thumbs img { max-height: 64px; border-radius: 4px; border: 1px solid #2a3140;
  cursor: zoom-in; }

/* streaming-STT partials → an inline word diff (same palette as the patch diff:
   one visual language for "text changed in front of you"). A struck-through run
   on a CUMULATIVE partial means the vendor revised itself — the thing to see. */
.aiui-dbg-diff { margin: 4px 0 0; padding: 5px 7px; background: #14171f; border-radius: 6px;
  font: 11px/1.6 ui-sans-serif, system-ui, sans-serif; word-break: break-word; }
.aiui-dbg-diff-same { color: #cfd3da; }
.aiui-dbg-diff-del { color: #ff5c87; background: #ff5c8722; border-radius: 3px;
  text-decoration: line-through; }
.aiui-dbg-diff-add { color: #7ee0a3; background: #7ee0a322; border-radius: 3px; }

/* the hero showing a speculative (not-yet-sent) prompt */
.aiui-dbg-hero-preview { margin-bottom: 6px; color: #ffd166; font-size: 11px;
  text-transform: uppercase; letter-spacing: .05em; }

/* correction patch → a real diff (mirrors the intent client's mm-diff palette) */
.aiui-dbg-patch { margin: 6px 0 0; padding: 6px 8px; background: #14171f; border-radius: 6px;
  font: 11px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
.aiui-dbg-patch-line { padding: 0 2px; border-radius: 3px; }
.aiui-dbg-patch-line.del { color: #ff5c87; background: #ff5c8722; }
.aiui-dbg-patch-line.add { color: #7ee0a3; background: #7ee0a322; }
.aiui-dbg-patch-line.meta, .aiui-dbg-patch-line.hunk { color: #6f7686; }
.aiui-dbg-patch-line.context { color: #cfd3da; }

/* the collapsed raw disclosure under each card */
.aiui-dbg-card-raw { margin-top: 6px; }
.aiui-dbg-card-raw > summary { cursor: pointer; color: #6f7686; font-size: 11px; user-select: none; }
.aiui-dbg-card-raw > summary:hover { color: #9aa0aa; }
.aiui-dbg-card-raw a { color: #8ab4f8; word-break: break-all; }
.aiui-dbg-card-raw > .aiui-dbg-json { margin-top: 4px; }

/* JsonTree (json-tree.ts) — the collapsible stage-data widget */
.aiui-dbg-json { font: 12px/1.6 ui-monospace, monospace; word-break: break-word; }
.aiui-dbg-json details { margin: 0; }
.aiui-dbg-json summary.aiui-dbg-json-summary { cursor: pointer; user-select: none; }
.aiui-dbg-json summary.aiui-dbg-json-summary::marker { color: #9aa0aa; font-size: 10px; }
.aiui-dbg-json-children { margin-left: 5px; padding-left: 14px; border-left: 1px solid #262c3a; }
.aiui-dbg-json-key { color: #8ab4f8; }
.aiui-dbg-json-mark { color: #9aa0aa; }
.aiui-dbg-json-count { color: #9aa0aa; font-size: 11px; margin-left: 6px; }
.aiui-dbg-json-preview { color: #6f7686; font-size: 11px; margin-left: 8px; }
/* the inline preview earns its keep only while the node is closed */
.aiui-dbg-json details[open] > summary > .aiui-dbg-json-preview { display: none; }
.aiui-dbg-json-string { color: #7ee0a3; white-space: pre-wrap; }
.aiui-dbg-json-number { color: #d0a8ff; }
.aiui-dbg-json-boolean { color: #ffd166; }
.aiui-dbg-json-null, .aiui-dbg-json-empty { color: #9aa0aa; }

/* ── the traces pane (list + live-followed TraceView; see traces-pane.ts) ── */
.aiui-dbgt { display: flex; flex-direction: column; min-height: 0; flex: 1;
  color: #cfd3da; font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.aiui-dbgt-bar { display: flex; align-items: center; gap: 4px; padding: 6px 10px;
  color: #9aa0aa; border-bottom: 1px solid #262c3a; flex: none; }
.aiui-dbgt-bar label { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; }
/* The picker — a chooser, not the content: since the 2026-07-12 rework it is
   a one-line dropdown (trigger + popup menu; see traces-pane.ts). */
.aiui-dbgt-list { max-height: 5.5rem; overflow-y: auto;
  border-bottom: 1px solid #262c3a; flex: none; }
.aiui-dbgt-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  background: transparent; border: none; color: #cfd3da; font: inherit; padding: 4px 10px;
  cursor: pointer; }
.aiui-dbgt-row:hover { background: #171b25; }
.aiui-dbgt-row.selected { background: #1b2130; color: #e8e8ea; }
.aiui-dbgt-row.dim { opacity: 0.55; }
.aiui-dbgt-badge { font-size: 10px; color: #9aa0aa; border: 1px solid #3a4152; border-radius: 999px;
  padding: 0 7px; }
.aiui-dbgt-view { flex: 1; overflow-y: auto; padding: 6px 10px; min-height: 0; }
.aiui-dbgt-empty { padding: 16px; color: #6b7280; }

/* ── the standalone debug page's header (title + channel picker) ── */
.aiui-dbgp-head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; flex: none;
  border-bottom: 1px solid #262c3a; background: #12151d;
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.aiui-dbgp-title { color: #e8e8ea; font-weight: 600; }
.aiui-dbgp-title::first-letter { color: #8ab4f8; }
.aiui-dbgp-picker { margin-left: auto; max-width: 46vw; background: #0f1117; color: #cfd3da;
  border: 1px solid #3a4152; border-radius: 6px; padding: 3px 8px; font: inherit; font-size: 12px; }
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
