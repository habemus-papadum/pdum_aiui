/**
 * The workbench shell's stylesheet: header, split layout, dock tabs, and the
 * workbench-local chrome around the shared panes (trace list rows, raw frame
 * rows, prompt view) — plus the spectra scenery. The intent overlay brings its
 * own `mm-*` styles when it mounts, and the debug-ui panes self-inject their
 * `aiui-dbg-*` sheet; nothing here restyles either.
 */
export const STYLES = /* css */ `
  body { margin: 0; background: #0f1117; color: #e8e8ea; font: 14px/1.5 ui-sans-serif, system-ui; }
  #wb-shell { display: flex; flex-direction: column; height: 100vh; }
  #wb-header { display: flex; align-items: center; gap: 14px; padding: 8px 16px;
    border-bottom: 1px solid #262c3a; background: #12151d; }
  #wb-header h1 { font-size: 15px; margin: 0; } #wb-header h1 span { color: #8ab4f8; }
  .wb-tagline { color: #6b7280; font-size: 11px; }
  #wb-app-pick { margin-left: auto; background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 12px; }
  .wb-chip { font-size: 11px; color: #9aa0aa; border: 1px solid #3a4152; border-radius: 999px;
    padding: 2px 10px; }
  .wb-chip.ok { color: #7ee0a3; border-color: #2c4a3a; }
  .wb-chip.err { color: #f28b82; border-color: #5a2c33; }

  #wb-split { display: flex; flex: 1; min-height: 0; }
  #wb-app { flex: 1; min-width: 0; overflow: auto; position: relative; }
  .wb-app-frame { width: 100%; height: 100%; border: none; display: block; }
  .wb-app-note { padding: 24px; color: #9aa0aa; }

  #wb-dock { width: 46%; min-width: 420px; display: flex; flex-direction: column;
    border-left: 1px solid #262c3a; background: #12151d; font-size: 12px; }
  #wb-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid #262c3a; }
  #wb-tabs button { background: transparent; border: 1px solid transparent; border-bottom: none;
    color: #9aa0aa; font: inherit; padding: 5px 12px; cursor: pointer;
    border-radius: 8px 8px 0 0; }
  #wb-tabs button.selected { background: #171b25; border-color: #262c3a; color: #e8e8ea; }
  #wb-pane-host { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  #wb-pane-host > * { flex: 1; min-height: 0; display: flex; flex-direction: column; }

  .wb-traces-bar { display: flex; align-items: center; gap: 4px; padding: 6px 10px;
    color: #9aa0aa; border-bottom: 1px solid #262c3a; }
  .wb-trace-list { max-height: 30%; overflow-y: auto; border-bottom: 1px solid #262c3a; }
  .wb-trace-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
    background: transparent; border: none; color: #cfd3da; font: inherit; padding: 4px 10px;
    cursor: pointer; }
  .wb-trace-row:hover { background: #171b25; }
  .wb-trace-row.selected { background: #1b2130; color: #e8e8ea; }
  .wb-trace-row.dim { opacity: 0.55; }
  .wb-badge { font-size: 10px; color: #ffd166; border: 1px solid #3a4152; border-radius: 999px;
    padding: 0 7px; }
  .wb-trace-view { flex: 1; overflow-y: auto; padding: 6px 10px; }
  .wb-empty { padding: 16px; color: #6b7280; }

  .wb-raw-log { flex: 1; overflow-y: auto; padding: 4px 10px; }
  .wb-frame { border-bottom: 1px solid #1b2130; padding: 4px 0; }
  .wb-frame-head { font: 11px/1.5 ui-monospace, monospace; color: #9aa0aa; }
  .wb-frame-in .wb-frame-head { color: #8ab4f8; }
  .wb-frame-out .wb-frame-head { color: #7ee0a3; }

  .wb-prompt { overflow-y: auto; padding: 10px 12px; }
  .wb-prompt-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #9aa0aa; margin: 8px 0 4px; }
  .wb-prompt-text { background: #14171f; border: 1px solid #2a3140; border-radius: 8px;
    padding: 10px 12px; white-space: pre-wrap; font: 12px/1.6 ui-monospace, monospace; }
  .wb-prompt-history { margin-top: 12px; border-top: 1px solid #262c3a; }
  .wb-prompt-row { padding: 4px 0; color: #6b7280; border-bottom: 1px solid #1b2130;
    font: 11px/1.5 ui-monospace, monospace; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }

  /* ── spectra scenery (unchanged bones, now inside the left pane) ── */
  #wb-scenery header { padding: 18px 28px 6px; }
  #wb-scenery h1 { font-size: 17px; margin: 0; } #wb-scenery h1 span { color: #8ab4f8; }
  #wb-scenery .sub { color: #9aa0aa; font-size: 12px; }
  #wb-scenery main { padding: 10px 28px; display: flex; flex-direction: column; gap: 14px; }
  #wb-scenery .card { background: #171b25; border: 1px solid #262c3a; border-radius: 12px; padding: 16px 18px; max-width: 720px; }
  #wb-scenery .legend { display: flex; gap: 14px; font-size: 11px; color: #9aa0aa; margin-top: 8px; }
  #wb-scenery .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  #wb-scenery table { border-collapse: collapse; font-size: 12px; width: 100%; }
  #wb-scenery th, #wb-scenery td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #232936; }
  #wb-scenery th { color: #9aa0aa; font-weight: 500; }
`;
