/**
 * The lab's own stylesheet: scenery + the bench-only chrome (HUD, dock frame,
 * settings drawer). The ink / shot / preview / correction layers are the
 * overlay's now (`MULTIMODAL_STYLES`, mm-*), and the debug panes bring their own
 * `aiui-dbg-*` styles from the shared debug-ui — both injected alongside this in
 * main.ts. The dock is just the frame the panes and the settings drawer sit in.
 */
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

  body.wb-armed { cursor: crosshair; }

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

  .wb-dock { position: fixed; right: 0; top: 0; bottom: 0; width: 330px; z-index: 30;
    background: #12151d; border-left: 1px solid #262c3a; display: flex; flex-direction: column;
    font-size: 12px; }
  /* The events/IR/timing panes here are the shared debug-ui (aiui-dbg-*, self-styled). */
  .wb-settings { border-top: 1px solid #262c3a; max-height: 45%; overflow-y: auto; }
  .wb-settings-head { padding: 6px 8px; border-bottom: 1px solid #262c3a; color: #9aa0aa; }
  .wb-settings-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .wb-setting { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #9aa0aa; }
  .wb-setting input, .wb-setting select { background: #0f1117; color: #e8e8ea; border: 1px solid #3a4152;
    border-radius: 6px; padding: 3px 6px; font: inherit; width: 130px; }
`;
