/**
 * Self-contained styles for the shared debug UI.
 *
 * The panes were prototyped in the workbench, where the lab's own stylesheet
 * dressed them (`wb-insp-*`). Graduated here, the debug UI must look right in
 * two homes that share no CSS — the lab dock and the DevTools extension panel —
 * so it ships its own styles under an `aiui-dbg-` prefix and injects them once
 * per document. The palette matches the channel's `/debug` viewer so an
 * embedded pane is visually of a piece with the standalone trace debugger.
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

/* trace view (generic stages, the extension's live-follow) */
.aiui-dbg-trace { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow-y: auto; }
.aiui-dbg-trace-head h2 { font-size: 14px; margin: 0 0 2px; }
.aiui-dbg-trace-head .sub { color: #9aa0aa; font-size: 12px; margin-bottom: 14px; }
.aiui-dbg-tstage { margin-bottom: 12px; border: 1px solid #2a3140; border-radius: 10px; overflow: hidden; }
.aiui-dbg-thead { display: flex; gap: 8px; align-items: baseline; padding: 6px 12px;
  background: #1f2430; font-size: 12px; }
.aiui-dbg-tkind { font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: .06em; }
.aiui-dbg-tkind.input { color: #8ab4f8; }
.aiui-dbg-tkind.ir { color: #d0a8ff; }
.aiui-dbg-tkind.output { color: #7ee0a3; }
.aiui-dbg-tkind.info { color: #9aa0aa; }
.aiui-dbg-thead .at { margin-left: auto; color: #9aa0aa; font-size: 11px; }
.aiui-dbg-tbody { padding: 10px 12px; }
.aiui-dbg-tbody pre { margin: 0; white-space: pre-wrap; word-break: break-word;
  font: 12px/1.5 ui-monospace, monospace; }
.aiui-dbg-tbody img { max-width: 100%; border-radius: 6px; }
.aiui-dbg-tbody a { color: #8ab4f8; }
/* an event-log stage embeds the full event panes; give it room */
.aiui-dbg-tbody .aiui-dbg { min-height: 260px; }
.aiui-dbg-tbody .aiui-dbg-pane { max-height: 320px; }

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
