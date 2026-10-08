/**
 * styles.ts — the default composition's CSS (the old lab client's, plus the
 * knob styles and the `--remote-accent` hook a presentation's `accent` sets).
 *
 * SHIPPED chrome: the picker, HUD, bars, and buttons read the design system's
 * prefixed `--aiui-*` hooks with neutral fallbacks (system colors), so the
 * served client is of a piece with a host that sets them and quiet in any
 * other. The STAGE — the video and the drawing surface over it — stays black
 * whatever the chrome: it is a plate, not a panel.
 */
export const REMOTE_APP_CSS = `
  :root { color-scheme: light; }
  * { margin: 0; box-sizing: border-box; }
  body { background: var(--aiui-surface, Canvas); color: var(--aiui-ink, CanvasText);
         font: 15px/1.4 var(--aiui-sans, system-ui, sans-serif); }
  /* An instrument panel, not a document: nothing here is text to select. A
     resting palm is a LONG-PRESS, and iOS answered it with text selection on
     whatever label it landed on (the HUD's "host…" — found live 2026-07-25),
     whose selection UI then ate the pen strokes that followed. */
  .remote { height: 100dvh; display: flex; flex-direction: column;
            -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .picker { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 12px; }
  .picker h1 { font-size: 18px; font-weight: 600; }
  .session { padding: 12px 20px; border-radius: var(--aiui-radius, 0);
             border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent));
             background: var(--aiui-surface-raised, color-mix(in srgb, CanvasText 4%, Canvas));
             color: inherit; font-size: 15px; cursor: pointer;
             touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  .session:active:not(:disabled) { background: var(--aiui-ghost, color-mix(in srgb, currentColor 14%, transparent)); }
  .session:disabled { opacity: 0.4; }
  .session-meta { display: block; font-size: 11px;
                  color: var(--aiui-muted, color-mix(in srgb, currentColor 55%, transparent)); margin-top: 2px; }
  .stage-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .stage { position: relative; flex: 1; min-height: 0; touch-action: none; overflow: hidden;
           background: #000; }
  .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
                 background: #000; }
  .plane { position: absolute; pointer-events: none; }
  .preview-canvas { position: absolute; inset: 0; width: 100%; height: 100%;
                    pointer-events: none; }
  .no-video { position: absolute; inset: 0; display: grid; place-items: center; color: #9aa3b5;
              padding: 24px; text-align: center; background: #0d0d11; }
  /* The HUD floats over the black stage: a paper chip, so it reads on the plate. */
  .hud { position: absolute; left: 8px; bottom: 8px; z-index: 3;
         font: 11px var(--aiui-mono, ui-monospace, monospace);
         color: var(--aiui-ink-muted, CanvasText);
         background: color-mix(in srgb, var(--aiui-surface, Canvas) 88%, transparent);
         border: 1px solid var(--aiui-hairline, color-mix(in srgb, CanvasText 30%, Canvas));
         border-radius: var(--aiui-radius, 0); padding: 3px 8px; cursor: pointer;
         touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
  .hud[data-open="false"] { opacity: 0.6; }
  .hud[data-stale="true"] { color: var(--aiui-warn, #8a5f10); border-color: var(--aiui-warn, #8a5f10); }
  .host-bar { background: var(--aiui-surface-raised, color-mix(in srgb, CanvasText 4%, Canvas));
              border-top: 1px solid var(--aiui-hairline, color-mix(in srgb, CanvasText 30%, Canvas)); }
  .bar { display: flex; gap: 8px; padding: 10px; justify-content: center; align-items: center;
         flex-wrap: wrap; background: var(--aiui-surface-raised, color-mix(in srgb, CanvasText 4%, Canvas));
         border-top: 1px solid var(--aiui-hairline, color-mix(in srgb, CanvasText 30%, Canvas)); }
  .bar button { padding: 10px 16px; border-radius: var(--aiui-radius, 0);
                border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent));
                background: transparent; color: inherit; font-size: 14px; cursor: pointer;
                touch-action: manipulation; -webkit-tap-highlight-color: transparent;
                transition: transform 60ms ease-out, background 60ms ease-out,
                            border-color 60ms ease-out; }
  .bar button:active { transform: scale(0.92);
                       background: var(--aiui-ghost, color-mix(in srgb, currentColor 14%, transparent));
                       border-color: var(--remote-accent, var(--aiui-accent, LinkText)); }
  .bar button[data-lit="true"] { border-color: var(--remote-accent, var(--aiui-accent, LinkText));
                                 color: var(--remote-accent, var(--aiui-accent, LinkText)); }
  .knob { display: inline-flex; align-items: center; gap: 4px; }
  .knob input[type="color"] { width: 34px; height: 34px; padding: 0;
                              border: 1px solid var(--aiui-hairline, color-mix(in srgb, currentColor 35%, transparent));
                              border-radius: var(--aiui-radius, 0); background: transparent; }
  .knob input[type="range"] { width: 90px; accent-color: var(--remote-accent, var(--aiui-accent, LinkText)); }
  .knob-reset { padding: 2px 6px !important; font-size: 11px !important; }
  .pen-chip { align-self: center; padding: 4px 10px; border-radius: 999px; font-size: 12px;
              background: transparent; color: var(--aiui-ok, #2a6e4e); border: 1px solid var(--aiui-ok, #2a6e4e); }
`;
