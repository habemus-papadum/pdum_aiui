/**
 * styles.ts — the default composition's CSS (the old lab client's, plus the
 * knob styles and the `--remote-accent` hook a presentation's `accent` sets).
 */
export const REMOTE_APP_CSS = `
  * { margin: 0; box-sizing: border-box; }
  body { background: #0d0d11; color: #e8e8ee; font: 15px/1.4 system-ui, sans-serif; }
  .remote { height: 100dvh; display: flex; flex-direction: column; }
  .picker { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 12px; }
  .picker h1 { font-size: 18px; font-weight: 600; }
  .session { padding: 12px 20px; border-radius: 10px; border: 1px solid #333;
             background: #1a1a22; color: inherit; font-size: 15px; cursor: pointer; }
  .session:disabled { opacity: 0.4; }
  .session-meta { display: block; font-size: 11px; color: #888; margin-top: 2px; }
  .stage-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .stage { position: relative; flex: 1; min-height: 0; touch-action: none; overflow: hidden; }
  .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
                 background: #000; }
  .plane { position: absolute; pointer-events: none; }
  .preview-canvas { position: absolute; inset: 0; width: 100%; height: 100%;
                    pointer-events: none; }
  .no-video { position: absolute; inset: 0; display: grid; place-items: center; color: #888;
              padding: 24px; text-align: center; }
  .host-bar { background: #101016; border-top: 1px solid #26262e; }
  .bar { display: flex; gap: 8px; padding: 10px; justify-content: center; align-items: center;
         flex-wrap: wrap; background: #16161c; border-top: 1px solid #26262e; }
  .bar button { padding: 10px 16px; border-radius: 8px; border: 1px solid #333;
                background: #1a1a22; color: inherit; font-size: 14px; cursor: pointer; }
  .bar button[data-lit="true"] { border-color: var(--remote-accent, #7aa2ff);
                                 color: var(--remote-accent, #a9c4ff); }
  .knob { display: inline-flex; align-items: center; gap: 4px; }
  .knob input[type="color"] { width: 34px; height: 34px; padding: 0; border: 1px solid #333;
                              border-radius: 8px; background: #1a1a22; }
  .knob input[type="range"] { width: 90px; accent-color: var(--remote-accent, #7aa2ff); }
  .knob-reset { padding: 2px 6px !important; font-size: 11px !important; }
  .pen-chip { align-self: center; padding: 4px 10px; border-radius: 999px; font-size: 12px;
              background: #223122; color: #9fd89f; border: 1px solid #3b573b; }
`;
