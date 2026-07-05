/**
 * The app-under-test: the familiar "spectra" viewer, but with each component
 * annotated the way a locator-style vite plugin would annotate a real app —
 * `data-comp` (component name) + `data-source` (file:line). That's what the
 * shot tool's locator pass resolves screenshot rects against; in production
 * these attributes come from build-time instrumentation, not by hand.
 */
export function mountScenery(host: HTMLElement): void {
  host.innerHTML = `
    <div data-comp="AppShell" data-source="workbench/src/scenery.ts:12">
      <header data-comp="Header" data-source="workbench/src/scenery.ts:14">
        <h1><span>spectra</span> · absorption viewer</h1>
        <div class="sub">workbench scenery — arm the overlay (\`), then talk / draw / shoot</div>
      </header>
      <main>
        <div class="card" data-comp="SpectrumPlot" data-source="workbench/src/scenery.ts:20">
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
          <div class="legend" data-comp="Legend" data-source="workbench/src/scenery.ts:33">
            <span><i style="background:#8ab4f8"></i>sample A-113</span>
            <span><i style="background:#7ee0a3"></i>baseline</span>
          </div>
        </div>
        <div class="card" data-comp="SampleTable" data-source="workbench/src/scenery.ts:39">
          <table>
            <thead><tr><th>sample</th><th>λ max</th><th>absorbance</th></tr></thead>
            <tbody>
              <tr><td>A-113</td><td>548 nm</td><td>0.82</td></tr>
              <tr><td>A-117</td><td>562 nm</td><td>0.64</td></tr>
              <tr><td>baseline</td><td>—</td><td>0.05</td></tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>`;
}
