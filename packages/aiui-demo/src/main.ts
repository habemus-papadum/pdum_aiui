/**
 * The demo app: a fake "scientific UI" the intent tool mounts over.
 *
 * The app itself is throwaway scenery (an SVG spectrum plot) — note there is
 * **no aiui code in here at all**. The whole integration is the
 * `aiuiDevOverlay()` plugin in vite.config.ts, which injects and mounts the
 * widget into every served page. Run it the intended way:
 *
 *   terminal 1:  ./aiui claude          (a session with the channel attached)
 *   terminal 2:  pnpm demo              (aiui vite serving this app)
 *
 * then click the ✳ aiui button, type something, and watch it arrive in the
 * session. The 🔍 button opens the lowering-trace debugger. Without a channel
 * (plain `pnpm --filter @habemus-papadum/aiui-demo dev`) everything still
 * renders — the widget just tells you it has no port when you send.
 */

document.body.innerHTML = `
  <style>
    body { margin: 0; background: #0f1117; color: #e8e8ea; font: 14px/1.5 ui-sans-serif, system-ui; }
    header { padding: 18px 28px 6px; }
    h1 { font-size: 17px; margin: 0; } h1 span { color: #8ab4f8; }
    .sub { color: #9aa0aa; font-size: 12px; }
    main { padding: 10px 28px; }
    .card { background: #171b25; border: 1px solid #262c3a; border-radius: 12px; padding: 16px 18px; max-width: 720px; }
    .legend { display: flex; gap: 14px; font-size: 11px; color: #9aa0aa; margin-top: 8px; }
    .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  </style>
  <header>
    <h1><span>spectra</span> · absorption viewer</h1>
    <div class="sub">demo app for the aiui web intent tool — the widget in the corner is the tool</div>
  </header>
  <main>
    <div class="card">
      <svg viewBox="0 0 640 220" width="100%" role="img" aria-label="demo spectrum plot">
        <g stroke="#262c3a"><line x1="40" y1="10" x2="40" y2="190"/><line x1="40" y1="190" x2="620" y2="190"/>
        <line x1="40" y1="55" x2="620" y2="55" stroke-dasharray="3 5"/><line x1="40" y1="100" x2="620" y2="100" stroke-dasharray="3 5"/>
        <line x1="40" y1="145" x2="620" y2="145" stroke-dasharray="3 5"/></g>
        <polyline fill="none" stroke="#8ab4f8" stroke-width="2"
          points="40,180 90,176 130,168 165,120 185,60 205,38 225,64 260,150 310,170 355,162 390,132 420,90 445,74 470,96 510,158 560,174 620,178"/>
        <polyline fill="none" stroke="#7ee0a3" stroke-width="2" stroke-dasharray="5 4"
          points="40,185 100,182 150,176 200,150 250,120 300,104 350,110 400,128 450,148 500,164 560,175 620,180"/>
        <g fill="#9aa0aa" font-size="10"><text x="30" y="200" text-anchor="end">400</text><text x="330" y="205" text-anchor="middle">wavelength (nm)</text><text x="620" y="200" text-anchor="end">700</text></g>
      </svg>
      <div class="legend"><span><i style="background:#8ab4f8"></i>sample A-113</span><span><i style="background:#7ee0a3"></i>baseline</span></div>
    </div>
  </main>
`;
