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
  .mm-thumb { height: 34px; border-radius: 4px; border: 1px solid #262c3a; vertical-align: middle; margin: 0 4px; }
  .mm-thumb-chip { font-size: 11px; color: #ffd166; border: 1px solid #3a4152; border-radius: 999px;
    padding: 1px 8px; margin: 0 4px; }
  .mm-correction-bar { display: flex; margin-top: 8px; }
  .mm-correction-bar input { flex: 1; background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 6px 10px; font: inherit; }
`;
