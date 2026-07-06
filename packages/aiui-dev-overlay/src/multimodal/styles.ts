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

  .mm-hud { position: fixed; left: 16px; bottom: 16px; z-index: 2147483643; display: flex; gap: 10px;
    align-items: center; background: #171b25; border: 1px solid #262c3a; border-radius: 999px;
    padding: 6px 14px 6px 6px; font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #9aa0aa; }
  .mm-hud.armed { border-color: #8ab4f8; }
  .mm-hud.talking { border-color: #ff5c87; }
  .mm-arm { width: 30px; height: 30px; border-radius: 50%; border: none; cursor: pointer;
    background: #232936; color: #e8e8ea; font-size: 15px; }
  .mm-hud.armed .mm-arm { background: #8ab4f8; color: #0f1117; }
  .mm-state { min-width: 90px; color: #e8e8ea; }
  .mm-meter { border-radius: 3px; background: #0f1117; }
  .mm-keys { opacity: 0.7; }

  .mm-preview { position: fixed; left: 50%; transform: translateX(-50%); bottom: 64px;
    z-index: 2147483642; width: min(560px, 70vw); background: #171b25ee; border: 1px solid #262c3a;
    border-radius: 12px; padding: 10px 14px; display: none;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #e8e8ea; }
  .mm-preview.visible { display: block; }
  .mm-preview.correcting { border-color: #ffd166; bottom: 120px; width: min(720px, 80vw); }
  .mm-preview-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0aa; }
  .mm-preview.correcting .mm-preview-title::after { content: " — select the text to fix"; color: #ffd166; }
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
  .mm-correction-bar { display: flex; margin-top: 8px; }
  .mm-correction-bar input { flex: 1; background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 6px 10px; font: inherit; }

  .mm-config-strip { position: fixed; left: 16px; bottom: 62px; z-index: 2147483643; display: none;
    background: #171b25ee; border: 1px solid #262c3a; border-radius: 12px; padding: 10px 14px;
    font: 12px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #9aa0aa;
    max-width: min(560px, 90vw); }
  .mm-config-strip.visible { display: block; }
  .mm-strip-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0aa; }
  .mm-strip-layer { text-transform: none; letter-spacing: 0; color: #6b7280; margin-left: 6px; }
  .mm-strip-tiers { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .mm-tier-chip { border: 1px solid #3a4152; border-radius: 999px; padding: 2px 10px; color: #cfd3da; }
  .mm-tier-chip b { color: #9aa0aa; font-weight: 600; margin-right: 4px; }
  .mm-tier-chip.active { border-color: #8ab4f8; color: #8ab4f8; }
  .mm-tier-chip.active b { color: #8ab4f8; }
  .mm-tier-chip.pending { border-style: dashed; border-color: #ffd166; color: #ffd166; }
  .mm-strip-pending { margin-top: 6px; color: #ffd166; }
  .mm-strip-note { margin-top: 6px; color: #7ee0a3; }
  .mm-strip-actions { margin-top: 6px; color: #6b7280; }
  .mm-strip-actions b { color: #9aa0aa; }
`;
