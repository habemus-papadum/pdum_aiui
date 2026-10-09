/**
 * The dock's own rules; the oracle and live widgets bring theirs. Shipped
 * chrome: every color and face reads a prefixed `--aiui-*` hook with a neutral
 * fallback (system colors, currentColor mixes), so the dock is of a piece with
 * the design system where a page sets the hooks and inoffensive on any other
 * page. Status is a dot; an open pill is inverted, not tinted. The source
 * pane's code colours are highlight.js classes mapped onto the same hooks.
 */
export const DOCK_STYLES = `
.aiui-dock { position: fixed; right: 8px; bottom: 8px; z-index: 2147483000;
  font: 12px/1.4 var(--aiui-sans, ui-sans-serif, system-ui, sans-serif);
  color: var(--aiui-ink, CanvasText); }
.aiui-dock-row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.aiui-dock-pill { background: var(--aiui-surface, Canvas); color: inherit;
  border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent));
  border-radius: 999px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 11px;
  letter-spacing: 0.08em; text-transform: uppercase; display: inline-flex;
  align-items: center; gap: 6px; }
.aiui-dock-pill:hover { border-color: var(--aiui-ink, currentColor); }
.aiui-dock-pill[aria-pressed="true"] { background: var(--aiui-ink, CanvasText);
  color: var(--aiui-surface, Canvas); border-color: var(--aiui-ink, CanvasText); }
.aiui-dock-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent)); }
.aiui-dock-dot[data-status="connecting"], .aiui-dock-dot[data-status="closing"] {
  background: var(--aiui-warn, #d97706); }
.aiui-dock-dot[data-status="live"] { background: var(--aiui-ok, #16a34a); }
.aiui-dock-dot[data-status="parked"] { background: var(--aiui-accent, #2563eb); }
.aiui-dock-dot[data-status="error"] { background: var(--aiui-alarm, #dc2626); }
.aiui-dock-pane { position: fixed; right: 8px; bottom: 44px; width: min(480px, calc(100vw - 16px));
  max-height: 72vh; overflow: auto; background: var(--aiui-surface-raised, Canvas);
  color: var(--aiui-ink, CanvasText);
  border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent));
  border-radius: var(--aiui-radius, 8px); padding: 10px; box-sizing: border-box; }
.aiui-dock-pane h4 { margin: 8px 0 4px; font-size: 11px; font-weight: 400; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-dock-backends { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.aiui-dock-backend { background: transparent; color: inherit;
  border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent));
  border-radius: var(--aiui-radius, 6px); padding: 3px 8px; cursor: pointer; font: inherit; }
.aiui-dock-backend[data-on="true"] { background: var(--aiui-ink, CanvasText);
  color: var(--aiui-surface, Canvas); border-color: var(--aiui-ink, CanvasText); }
.aiui-dock-backend:disabled { opacity: 0.45; cursor: not-allowed; }
.aiui-dock-note { color: var(--aiui-ink-muted, color-mix(in srgb, currentColor 75%, transparent)); font-size: 11px; margin: 4px 0; }
.aiui-dock details { margin-top: 8px; }
.aiui-dock details summary { cursor: pointer; color: var(--aiui-ink-muted, color-mix(in srgb, currentColor 75%, transparent)); }
.aiui-dock details pre { white-space: pre-wrap;
  font: 11px/1.4 var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  max-height: 260px; overflow: auto; margin: 6px 0 0; }
.aiui-dock .aiui-toollog { bottom: 44px !important; }
.aiui-dock-main { font-weight: 600; }
.aiui-dock-main[aria-expanded="true"] { border-color: var(--aiui-ink, currentColor); }
.aiui-dock-pane-source { width: min(920px, calc(100vw - 16px)); max-height: 80vh; padding: 8px;
  overflow: hidden; }
.aiui-src { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr); gap: 10px; height: calc(80vh - 18px); }
.aiui-src-tree { min-height: 0; overflow: auto; font-size: 11px; padding-right: 6px;
  border-right: 1px solid var(--aiui-ghost, color-mix(in srgb, currentColor 15%, transparent)); }
.aiui-src-mode { margin: 0 0 6px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-src-nodes { list-style: none; margin: 0; padding: 0 0 0 10px; }
.aiui-src-tree > .aiui-src-nodes { padding-left: 0; }
.aiui-src-nodes details > summary { list-style: none; }
.aiui-src-nodes details > summary::-webkit-details-marker { display: none; }
.aiui-src-dir { cursor: pointer; padding: 1px 0; white-space: nowrap;
  color: var(--aiui-ink-muted, color-mix(in srgb, currentColor 75%, transparent)); }
.aiui-src-dir::before { content: "▸ "; font-size: 9px; }
.aiui-src-nodes details[open] > .aiui-src-dir::before { content: "▾ "; }
.aiui-src-file { display: block; width: 100%; text-align: left; background: transparent; color: inherit;
  border: 0; padding: 1px 4px; cursor: pointer; font: inherit; white-space: nowrap;
  border-radius: var(--aiui-radius, 4px); }
.aiui-src-file:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
.aiui-src-file[aria-current="true"] { background: var(--aiui-ink, CanvasText); color: var(--aiui-surface, Canvas); }
.aiui-src-view { min-height: 0; min-width: 0; overflow: auto; }
.aiui-src-head { display: flex; gap: 10px; align-items: baseline; margin: 0 0 6px; font-size: 11px; }
.aiui-src-path { font: 11px var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.aiui-src-count { color: var(--aiui-muted, color-mix(in srgb, currentColor 60%, transparent)); }
.aiui-src-code { margin: 0; font: 11px/1.5 var(--aiui-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  tab-size: 2; }
.aiui-src-line { display: flex; white-space: pre; }
.aiui-src-line:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
.aiui-src-n { flex: 0 0 3.5em; text-align: right; padding-right: 1em; user-select: none;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 45%, transparent)); }
.aiui-src-text { flex: 1 1 auto; }
.aiui-src .hljs-comment, .aiui-src .hljs-quote { font-style: italic;
  color: var(--aiui-muted, color-mix(in srgb, currentColor 55%, transparent)); }
.aiui-src .hljs-keyword, .aiui-src .hljs-selector-tag, .aiui-src .hljs-meta, .aiui-src .hljs-doctag,
.aiui-src .hljs-tag .hljs-name, .aiui-src .hljs-section { color: var(--aiui-accent, #2563eb); }
.aiui-src .hljs-string, .aiui-src .hljs-regexp, .aiui-src .hljs-addition, .aiui-src .hljs-template-tag,
.aiui-src .hljs-selector-attr, .aiui-src .hljs-selector-pseudo { color: var(--aiui-ok, #16a34a); }
.aiui-src .hljs-number, .aiui-src .hljs-literal, .aiui-src .hljs-symbol, .aiui-src .hljs-attr,
.aiui-src .hljs-attribute, .aiui-src .hljs-variable, .aiui-src .hljs-selector-class,
.aiui-src .hljs-selector-id, .aiui-src .hljs-bullet { color: var(--aiui-warn, #b45309); }
.aiui-src .hljs-title, .aiui-src .hljs-type, .aiui-src .hljs-built_in, .aiui-src .hljs-strong,
.aiui-src .hljs-name { color: var(--aiui-ink, inherit); font-weight: 600; }
.aiui-src .hljs-property, .aiui-src .hljs-params, .aiui-src .hljs-punctuation {
  color: var(--aiui-ink-muted, color-mix(in srgb, currentColor 80%, transparent)); }
.aiui-src .hljs-deletion { color: var(--aiui-alarm, #dc2626); }
.aiui-src .hljs-emphasis { font-style: italic; }
@media (max-width: 480px) {
  .aiui-dock { right: 6px; bottom: 6px; max-width: calc(100vw - 12px); }
  .aiui-dock-row { flex-wrap: wrap; }
  .aiui-dock-pill { padding: 2px 7px; font-size: 10px; letter-spacing: 0.04em; }
  .aiui-src { grid-template-columns: 1fr; grid-template-rows: minmax(0, 30vh) minmax(0, 1fr); }
  .aiui-src-tree { border-right: 0; }
}
`;
