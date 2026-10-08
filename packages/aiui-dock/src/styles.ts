/** The dock's own rules; the oracle and live widgets bring theirs. */
export const DOCK_STYLES = `
.aiui-dock { position: fixed; right: 8px; bottom: 8px; z-index: 2147483000;
  font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; color: #e6e6ea; }
.aiui-dock-row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.aiui-dock-pill { background: rgba(20, 20, 24, 0.92); color: inherit; border: 1px solid #444;
  border-radius: 999px; padding: 4px 10px; cursor: pointer; font: inherit; display: inline-flex;
  align-items: center; gap: 6px; }
.aiui-dock-pill:hover { border-color: #888; }
.aiui-dock-pill[aria-pressed="true"] { border-color: #8ab4f8; background: rgba(30, 36, 52, 0.96); }
.aiui-dock-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #666; }
.aiui-dock-dot[data-status="connecting"], .aiui-dock-dot[data-status="closing"] { background: #fbbf24; }
.aiui-dock-dot[data-status="live"] { background: #4ade80; }
.aiui-dock-dot[data-status="parked"] { background: #60a5fa; }
.aiui-dock-dot[data-status="error"] { background: #f87171; }
.aiui-dock-pane { position: fixed; right: 8px; bottom: 44px; width: min(480px, calc(100vw - 16px));
  max-height: 72vh; overflow: auto; background: rgba(20, 20, 24, 0.96); border: 1px solid #444;
  border-radius: 8px; padding: 10px; box-sizing: border-box; }
.aiui-dock-pane h4 { margin: 8px 0 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; opacity: 0.7; }
.aiui-dock-backends { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.aiui-dock-backend { background: transparent; color: inherit; border: 1px solid #444; border-radius: 6px;
  padding: 3px 8px; cursor: pointer; font: inherit; }
.aiui-dock-backend[data-on="true"] { border-color: #8ab4f8; background: rgba(30, 36, 52, 0.96); }
.aiui-dock-backend:disabled { opacity: 0.45; cursor: not-allowed; }
.aiui-dock-note { opacity: 0.7; font-size: 11px; margin: 4px 0; }
.aiui-dock details { margin-top: 8px; }
.aiui-dock details summary { cursor: pointer; opacity: 0.8; }
.aiui-dock details pre { white-space: pre-wrap; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  max-height: 260px; overflow: auto; margin: 6px 0 0; }
.aiui-dock .aiui-toollog { bottom: 44px !important; }
`;
