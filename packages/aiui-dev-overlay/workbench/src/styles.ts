/**
 * The workbench shell's stylesheet: header, split layout, and the spectra
 * scenery. The dock is the shared debug-ui {@link TracesPane}, which brings its
 * own `aiui-dbgt-*` styles (as the trace view brings `aiui-dbg-*` and the
 * intent overlay brings `mm-*`); nothing here restyles any of them.
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
  #wb-pane-host { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  #wb-pane-host > * { flex: 1; min-height: 0; display: flex; flex-direction: column; }

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
