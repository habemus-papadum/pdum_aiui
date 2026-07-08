/**
 * The multimodal layers' stylesheet — ink canvas, shot veil, HUD, and the
 * streaming preview with its correction meta-mode. Class-prefixed `mm-` and
 * injected once into a scoped `<style>`; the only bare selector is
 * `body.mm-armed` (the crosshair cursor while armed), a deliberate page-level
 * effect. The scenery/inspector/settings chrome stays in the workbench lab.
 */
export const STYLES = /* css */ `
  .mm-ink { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 2147483640; pointer-events: none; }
  body.mm-armed { cursor: crosshair; }

  .mm-shot-veil { position: fixed; inset: 0; z-index: 2147483641; display: none; cursor: crosshair;
    background: rgba(15, 17, 23, 0.25); }
  .mm-shot-box { position: fixed; display: none; border: 1.5px dashed #ffd166;
    background: rgba(255, 209, 102, 0.08); pointer-events: none; }

  /* bottom clears the widget's tallest resting state (pill + the below-pill
     cheat sheet at ~110px); both are draggable, this is just the rest pose. */
  .mm-preview { position: fixed; left: 50%; transform: translateX(-50%); bottom: 136px;
    z-index: 2147483642; width: min(560px, 70vw); background: #171b25ee; border: 1px solid #262c3a;
    border-radius: 12px; padding: 10px 14px; display: none;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #e8e8ea;
    cursor: grab; touch-action: none; }
  .mm-preview-body, .mm-correction-bar { cursor: auto; touch-action: auto; }
  /* The visible transcript announces itself: a bright blue border with a slow
     soft pulse (the pill's ring pulses in step) — the old 1px #262c3a border
     disappeared against dark app content. Pure CSS, no state driving it. */
  .mm-preview.visible { display: block; border-color: #8ab4f8; }
  .mm-preview.visible:not(.correcting) { animation: mm-preview-pulse 2.4s ease-in-out infinite; }
  @keyframes mm-preview-pulse {
    0%, 100% { border-color: #8ab4f8; box-shadow: 0 0 0 0 rgba(138, 180, 248, 0.35); }
    50% { border-color: #b7d0fa; box-shadow: 0 0 0 4px rgba(138, 180, 248, 0.10); }
  }
  .mm-preview.correcting { border-color: #ffd166; bottom: 120px; width: min(720px, 80vw); }
  .mm-preview-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0aa; }
  .mm-preview.correcting .mm-preview-title::after { content: " — edit the text directly, or instruct below"; color: #ffd166; }
  .mm-preview-body { max-height: 130px; overflow-y: auto; font-size: 14px; line-height: 1.7; }
  .mm-preview.correcting .mm-preview-body { max-height: 240px; font-size: 16px; }
  .mm-seg { color: #cfd3da; } .mm-seg.final { color: #e8e8ea; }
  .mm-seg mark { background: #ffd16633; color: #ffd166; border-radius: 3px; padding: 0 2px; }
  .mm-preview-body { user-select: none; }
  .mm-preview.correcting .mm-preview-body { user-select: text; cursor: text; }
  .mm-preview.correcting .mm-preview-body ::selection { background: #ffd16655; }
  .mm-diff-del { color: #ff5c87; background: #ff5c8722; text-decoration: line-through; border-radius: 3px; }
  .mm-diff-add { color: #7ee0a3; background: #7ee0a322; border-radius: 3px; }
  .mm-thumb-wrap { position: relative; display: inline-block; margin: 0 4px; vertical-align: middle; }
  .mm-thumb { height: 34px; border-radius: 4px; border: 2px solid #ffd166; vertical-align: middle;
    display: block; }
  .mm-thumb-chip { font-size: 11px; color: #ffd166; border: 1px solid #3a4152; border-radius: 999px;
    padding: 1px 8px; display: inline-block; }
  .mm-thumb-x { position: absolute; top: -7px; right: -7px; width: 16px; height: 16px; padding: 0;
    border: 1px solid #3a4152; border-radius: 50%; background: #171b25; color: #f28b82;
    font: 10px/1 ui-sans-serif, system-ui; cursor: pointer; display: none; align-items: center;
    justify-content: center; }
  .mm-thumb-wrap:hover .mm-thumb-x { display: flex; }
  .mm-thumb-x:hover { background: #f28b82; color: #171b25; border-color: #f28b82; }
  .mm-thumb-peek { position: fixed; z-index: 2147483644; max-width: min(480px, 60vw);
    max-height: 50vh; border: 2px solid #ffd166; border-radius: 8px; background: #0f1117;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); pointer-events: none; }
  /* Selection chips — app (⌖ sel_N) and code (⧉ code_N) — MINIMAL pills at
     their stream position, the same footprint as the degraded shot chip; the
     blue family separates "selection" from the amber shots, and the glyph
     separates the two kinds. Substance lives in the hover peek (below) and
     the title; the hover ✕ reuses the shot thumb's mm-thumb-x. */
  .mm-sel-chip { font-size: 11px; border: 1px solid #3a4152; border-radius: 999px;
    padding: 1px 8px; display: inline-block; vertical-align: middle;
    white-space: nowrap; }
  .mm-sel-app { color: #8ab4f8; }
  .mm-sel-code { color: #a5c8ff; }
  /* Confidence heat: low-logprob words carry a warm tint (alpha scales with
     how unsure the transcriber was, normalized over the turn). */
  .mm-heat-word { border-radius: 3px; padding: 0 1px; }
  /* A linter note: read-only advice, visually distinct from content chips. */
  .mm-lint-chip { font-size: 11px; border: 1px dashed #6b5d2e; border-radius: 999px;
    padding: 1px 8px; display: inline-block; vertical-align: middle;
    white-space: nowrap; color: #ffd166; }
  /* The selection peek: the mm-thumb-peek pattern (fixed-position, body-
     attached) as a card — source location + the selected text, clamped by CSS
     (the full text stays in the DOM; nothing is JS-truncated). */
  .mm-sel-peek { position: fixed; z-index: 2147483644; max-width: min(480px, 60vw);
    border: 1px solid #8ab4f8; border-radius: 8px; background: #0f1117;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55); pointer-events: none;
    padding: 8px 10px; font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .mm-sel-peek-loc { color: #9aa0aa; font-size: 11px; margin-bottom: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mm-sel-peek-text { color: #e8e8ea; white-space: pre-wrap; word-break: break-word;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6;
    overflow: hidden; }
  .mm-correction-bar { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .mm-correction-bar textarea { background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 6px 10px; font: inherit; resize: vertical; min-height: 2.6em; }
  .mm-correction-live { color: #9aa0aa; font-style: italic; font-size: 13px; }
  .mm-correction-live:empty { display: none; }
  .mm-correction-wait { color: #ffd166; font-size: 12px; animation: mm-wait-pulse 1.2s ease-in-out infinite; }
  .mm-edit-area { width: 100%; box-sizing: border-box; background: #0f1117; color: #e8e8ea;
    border: 1px solid #3a4152; border-radius: 6px; padding: 8px 10px; font-size: 15px;
    line-height: 1.6; font-family: inherit; resize: vertical; min-height: 72px; margin-top: 6px; }
  .mm-chunk-picker { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; cursor: default; }
  .mm-chunk-chip { border: 1px solid #3a4152; border-radius: 999px; padding: 1px 10px;
    color: #9aa0aa; font-size: 11px; cursor: pointer; }
  .mm-chunk-chip:hover { border-color: #8ab4f8; }
  .mm-chunk-chip.active { border-color: #ffd166; color: #ffd166; }
  .mm-seg.editing { background: #ffd16612; border-radius: 3px; box-shadow: 0 0 0 1px #ffd16633; }
  @keyframes mm-wait-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

  .mm-config-strip { position: fixed; left: 16px; bottom: 62px; z-index: 2147483643; display: none;
    background: #171b25ee; border: 1px solid #262c3a; border-radius: 12px; padding: 10px 14px;
    font: 12px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #9aa0aa;
    max-width: min(560px, 90vw);
    /* Its own cursor: the strip must not inherit body.mm-armed's crosshair —
       under a crosshair its clickable chips read as not-clickable. */
    cursor: default; }
  .mm-tier-chip, .mm-strip-actions [data-cmd] { cursor: pointer; }
  .mm-tier-chip:hover { border-color: #8ab4f8; }
  .mm-strip-actions [data-cmd]:hover b { color: #e8e8ea; }
  .mm-config-strip.visible { display: block; }
  .mm-strip-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0aa; }
  .mm-strip-layer { text-transform: none; letter-spacing: 0; color: #6b7280; margin-left: 6px; }
  .mm-strip-tiers { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .mm-tier-chip { border: 1px solid #3a4152; border-radius: 999px; padding: 2px 10px; color: #cfd3da; }
  .mm-tier-chip b { color: #9aa0aa; font-weight: 600; margin-right: 4px; }
  .mm-tier-chip.active { border-color: #8ab4f8; color: #8ab4f8; }
  .mm-tier-chip.active b { color: #8ab4f8; }
  .mm-tier-chip.pending { border-style: dashed; border-color: #ffd166; color: #ffd166; }
  .mm-strip-linter { margin-top: 6px; }
  .mm-strip-pending { margin-top: 6px; color: #ffd166; }
  .mm-strip-note { margin-top: 6px; color: #7ee0a3; }
  .mm-strip-actions { margin-top: 6px; color: #6b7280; }
  .mm-strip-actions b { color: #9aa0aa; }

  /* The jump picker (VS Code jump mode's double-click popup) and the on-page
     bounding-box highlight that tracks its selection. Same cursor opt-out
     rationale as the strip. VS Code blue matches the mode's pill ring. */
  .mm-jump-picker { position: fixed; z-index: 2147483645; display: none; min-width: 240px;
    max-width: min(420px, 90vw); background: #171b25ee; border: 1px solid #262c3a;
    border-radius: 10px; padding: 8px 0 4px; box-shadow: 0 6px 24px rgba(0,0,0,.4);
    font: 12px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #cfd3da;
    cursor: default; }
  .mm-jump-picker.visible { display: block; }
  .mm-jump-group { padding: 0 12px; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.08em; color: #9aa0aa; }
  .mm-jump-group:not(:first-child) { margin-top: 6px; }
  .mm-jump-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 12px;
    cursor: pointer; white-space: nowrap; }
  .mm-jump-row b { color: #9aa0aa; font-weight: 600; min-width: 10px; }
  .mm-jump-label { color: #e8e8ea; }
  .mm-jump-loc { color: #8ab4f8; overflow: hidden; text-overflow: ellipsis; }
  .mm-jump-row.active { background: #26437a; }
  .mm-jump-row.active b, .mm-jump-row.active .mm-jump-loc { color: #cfe1ff; }
  .mm-jump-row.disabled { cursor: default; }
  .mm-jump-row.disabled .mm-jump-label, .mm-jump-row.disabled .mm-jump-loc { color: #6b7280; }
  .mm-jump-hint { margin-top: 6px; padding: 4px 12px 2px; color: #6b7280;
    border-top: 1px solid #262c3a; }
  .mm-jump-highlight { position: fixed; z-index: 2147483644; display: none;
    pointer-events: none; border: 2px solid #3794ff; border-radius: 4px;
    background: rgba(55, 148, 255, 0.08); }
  .mm-jump-highlight.visible { display: block; }

  /* (The condensed cheat sheet moved into the widget's below-pill slot —
     its styles are CHEAT_STYLES in keymap-ui.tsx, injected into the shadow
     root via hudSlot.addStyle.) */
`;

/**
 * The HUD slot content's stylesheet — injected into the intent widget's
 * shadow root via `ctx.hudSlot().addStyle` (page-level sheets can't reach a
 * shadow tree). Content only: the pill provides the chrome — position,
 * background, the data-ui-mode ring, and the drag grip live in ui/widget.tsx.
 * The armed/talking classes here are raw-state hooks (✳ fill), not the ring.
 */
export const HUD_STYLES = /* css */ `
  .mm-hud { display: inline-flex; align-items: center; gap: 6px;
    font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #9aa0aa; }
  .mm-arm { width: 30px; height: 30px; border-radius: 50%; border: none; cursor: pointer;
    background: #232936; color: #e8e8ea; font-size: 15px; }
  .mm-hud.armed .mm-arm { background: #8ab4f8; color: #0f1117; }
  /* No reserved width: the pill hugs its content ("off" sits tight against
     the ✳ and the ?; the meter only appears while armed). */
  .mm-state { color: #e8e8ea; }
  /* The screen-share badge (realtime submode): a pulsing red dot beside the
     state label while the ~1fps sampler is running; hidden (attr) when off. */
  .mm-video { color: #ff5c87; font-size: 11px; font-weight: 600; white-space: nowrap;
    animation: mm-video-pulse 1.6s ease-in-out infinite; }
  .mm-video[hidden] { display: none; }
  @keyframes mm-video-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  .mm-meter { border-radius: 3px; background: #0f1117; }
  /* The share's cadence slider — tiny, only visible while sharing. */
  .mm-fps { width: 56px; height: 12px; accent-color: #ff5c87; cursor: pointer; }
  .mm-fps[hidden] { display: none; }
  .mm-meter[hidden] { display: none; }
  .mm-speaker { font-size: 11px; white-space: nowrap; }
`;
