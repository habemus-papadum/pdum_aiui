/** Real DOM text and symbols over a coordinate grid; width changes produce actual reflow. */
import type { JSX } from "@solidjs/web";

export function SceneContent(): JSX.Element {
  return (
    <section class="scene-scroll" tabindex={0} aria-label="Scrollable drawing scene">
      <div class="scene-spacer">
        <article class="scene-content" aria-label="Patterned reference content">
          <header class="scene-heading">
            <span class="scene-eyebrow">Pencil field notebook</span>
            <h2>Draw on the page. Move the view.</h2>
            <p>
              Circle a symbol or connect two cards. Pan, zoom, rotate, and scroll to check that your
              marks stay attached.
            </p>
            <div class="scene-origin">Origin (0, 0) · grid 40 units</div>
          </header>
          <div class="scene-cards">
            <section class="scene-card" data-scene-card="math">
              <span class="scene-card-number">01 · Mathematics</span>
              <h3>A local approximation</h3>
              <div class="scene-formula">f(x + h) ≈ f(x) + h f′(x)</div>
              <p>
                Mark the term you want to discuss, or write an example beside it. This paragraph
                wraps when the content width changes.
              </p>
            </section>
            <section class="scene-card" data-scene-card="circuit">
              <span class="scene-card-number">02 · Circuit</span>
              <h3>A simple low-pass filter</h3>
              <svg viewBox="0 0 280 150" role="img" aria-label="Resistor and capacitor circuit">
                <path d="M15 50H65l6-12 12 24 12-24 12 24 12-24 6 12h65M190 50h70M190 50v35M170 85h40M170 94h40M190 94v30M170 124h40M178 132h24M186 140h8" />
                <circle cx="190" cy="50" r="4" />
                <text x="82" y="24">
                  R
                </text>
                <text x="222" y="97">
                  C
                </text>
                <text x="10" y="79">
                  in
                </text>
                <text x="235" y="79">
                  out
                </text>
              </svg>
              <p>
                Draw a new connection or label a component. The circuit and ink share coordinates
                only while their views are linked.
              </p>
            </section>
            <section class="scene-card" data-scene-card="diagram">
              <span class="scene-card-number">03 · Diagram</span>
              <h3>Follow the transformation</h3>
              <div class="scene-diagram">
                <span>Samples</span>
                <b>→</b>
                <span>Path</span>
                <b>→</b>
                <span>Ink</span>
              </div>
              <p>
                Add an arrow between stages. The blocks are laid out by the browser, so narrowing
                this page changes their positions.
              </p>
            </section>
            <section class="scene-card" data-scene-card="notes">
              <span class="scene-card-number">04 · Notes</span>
              <h3>A place for an annotation</h3>
              <p>
                Write an equation, cross out a phrase, or sketch in the open area. Moving a view
                preserves the original samples and undo history.
              </p>
              <div class="scene-writing-lines" aria-hidden="true" />
            </section>
          </div>
          <section class="scene-lower">
            <span class="scene-card-number">05 · Further down the page</span>
            <h3>Your earlier ink is still above.</h3>
            <p>
              Scroll back to see it again. The canvas stays fixed in the lab while the view follows
              this scrollable content.
            </p>
            <div class="scene-landmark">
              ＋<small>Alignment target</small>
            </div>
          </section>
          <footer class="scene-footer">End of reference page · return with Reset view</footer>
        </article>
      </div>
    </section>
  );
}
