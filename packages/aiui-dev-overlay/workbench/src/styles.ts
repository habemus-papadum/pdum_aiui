/** One dark stylesheet for the whole bench (scenery + overlay chrome). */
export const STYLES = /* css */ `
  body { margin: 0; background: #0f1117; color: #e8e8ea; font: 14px/1.5 ui-sans-serif, system-ui; }
  #wb-scenery { padding-right: 340px; }
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

  .wb-ink { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 40; pointer-events: none; }
  body.wb-armed { cursor: crosshair; }

  .wb-shot-veil { position: fixed; inset: 0; z-index: 50; display: none; cursor: crosshair;
    background: rgba(15, 17, 23, 0.25); }
  .wb-shot-box { position: fixed; display: none; border: 1.5px dashed #ffd166;
    background: rgba(255, 209, 102, 0.08); pointer-events: none; }

  .wb-hud { position: fixed; left: 16px; bottom: 16px; z-index: 70; display: flex; gap: 10px;
    align-items: center; background: #171b25; border: 1px solid #262c3a; border-radius: 999px;
    padding: 6px 14px 6px 6px; font-size: 12px; color: #9aa0aa; }
  .wb-hud.armed { border-color: #8ab4f8; }
  .wb-hud.talking { border-color: #ff5c87; }
  .wb-arm { width: 30px; height: 30px; border-radius: 50%; border: none; cursor: pointer;
    background: #232936; color: #e8e8ea; font-size: 15px; }
  .wb-hud.armed .wb-arm { background: #8ab4f8; color: #0f1117; }
  .wb-state { min-width: 90px; color: #e8e8ea; }
  .wb-meter { border-radius: 3px; background: #0f1117; }
  .wb-keys { opacity: 0.7; }

  .wb-preview { position: fixed; left: 50%; transform: translateX(-50%); bottom: 64px; z-index: 60;
    width: min(560px, 70vw); background: #171b25ee; border: 1px solid #262c3a; border-radius: 12px;
    padding: 10px 14px; display: none; }
  .wb-preview.visible { display: block; }
  .wb-preview.correcting { border-color: #ffd166; bottom: 120px; width: min(720px, 80vw); }
  .wb-preview-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0aa; }
  .wb-preview.correcting .wb-preview-title::after { content: " — circle the text to fix"; color: #ffd166; }
  .wb-preview-body { max-height: 130px; overflow-y: auto; font-size: 14px; line-height: 1.7; }
  .wb-preview.correcting .wb-preview-body { max-height: 240px; font-size: 16px; }
  .wb-seg { color: #cfd3da; } .wb-seg.final { color: #e8e8ea; }
  .wb-seg mark { background: #ffd16633; color: #ffd166; border-radius: 3px; padding: 0 2px; }
  .wb-preview-body { user-select: none; }
  .wb-preview.correcting .wb-preview-body { user-select: text; cursor: text; }
  .wb-preview.correcting .wb-preview-body ::selection { background: #ffd16655; }
  .wb-diff-del { color: #ff5c87; background: #ff5c8722; text-decoration: line-through; border-radius: 3px; }
  .wb-diff-add { color: #7ee0a3; background: #7ee0a322; border-radius: 3px; }
  .wb-thumb { height: 34px; border-radius: 4px; border: 1px solid #262c3a; vertical-align: middle; margin: 0 4px; }
  .wb-thumb-chip { font-size: 11px; color: #ffd166; border: 1px solid #3a4152; border-radius: 999px;
    padding: 1px 8px; margin: 0 4px; }
  .wb-correction-bar { display: flex; margin-top: 8px; }
  .wb-correction-bar input { flex: 1; background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 6px 10px; font: inherit; }

  .wb-dock { position: fixed; right: 0; top: 0; bottom: 0; width: 330px; z-index: 30;
    background: #12151d; border-left: 1px solid #262c3a; display: flex; flex-direction: column;
    font-size: 12px; }
  .wb-inspector { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .wb-insp-tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid #262c3a; }
  .wb-insp-tabs button { background: none; border: none; color: #9aa0aa; cursor: pointer;
    padding: 4px 10px; border-radius: 6px; font: inherit; }
  .wb-insp-tabs button.active { background: #232936; color: #e8e8ea; }
  .wb-insp-tabs .wb-export { margin-left: auto; color: #8ab4f8; }
  .wb-insp-pane { flex: 1; overflow-y: auto; padding: 8px 10px; font-family: ui-monospace, monospace;
    font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .wb-ev { padding: 1px 0; color: #cfd3da; }
  .wb-ev-thread-open, .wb-ev-thread-close { color: #8ab4f8; }
  .wb-ev-transcript-final { color: #7ee0a3; }
  .wb-ev-correction { color: #ffd166; }
  .wb-ev-shot { color: #ffd166; }
  .wb-stage { margin-bottom: 12px; }
  .wb-stage-title { color: #8ab4f8; margin-bottom: 3px; }
  .wb-stage-body { color: #e8e8ea; }
  .wb-stage-extra { color: #ffd166; }
  .wb-path { color: #ffd166; border-bottom: 1px dotted #ffd16688; word-break: break-all; }
  .wb-path.img { cursor: zoom-in; }
  .wb-peek { position: fixed; z-index: 90; display: none; pointer-events: none;
    background: #1f2430; border: 1px solid #3a4152; border-radius: 8px; padding: 4px;
    box-shadow: 0 8px 30px #0009; }
  .wb-peek img { display: block; max-width: 380px; max-height: 280px; border-radius: 5px; }
  .wb-settings { border-top: 1px solid #262c3a; max-height: 45%; overflow-y: auto; }
  .wb-settings-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .wb-setting { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #9aa0aa; }
  .wb-setting input, .wb-setting select { background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 3px 6px; font: inherit; width: 130px; }
`;
