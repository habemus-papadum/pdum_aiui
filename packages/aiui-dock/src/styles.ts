/**
 * The dock's own rules; the oracle and live widgets bring theirs. Shipped
 * chrome: every color and face reads a prefixed `--aiui-*` hook with a neutral
 * fallback (system colors, currentColor mixes), so the dock is of a piece with
 * the design system where a page sets the hooks and inoffensive on any other
 * page. Status is a dot; an open pill is inverted, not tinted.
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
`;
