/**
 * Fidelity.tsx — the proof. Every case is rendered twice: plain (`TeX`, the
 * clean string) and marked (`RichTeX`, the same pieces as terms). The third
 * column lays the marked render over the plain one in difference blend —
 * solid black is pixel identity — and the instrument pairs every glyph and
 * reports the largest positional difference in CSS px.
 */
import { RichTeX, Term, TeX } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import {
  CASES,
  cleanTeX,
  type FidelityResult,
  measureFidelity,
  type Piece,
} from "../../model/fidelity";

/** Pieces → RichTeX children (fresh JSX per call, so each render owns its descriptors). */
function toChildren(pieces: readonly Piece[]): JSX.Element {
  return pieces.map((p) =>
    typeof p === "string" ? p : <Term id={p.id}>{toChildren(p.pieces)}</Term>,
  ) as unknown as JSX.Element;
}

export function Fidelity(): JSX.Element {
  const [results, setResults] = createSignal<FidelityResult[]>([]);
  const [outline, setOutline] = createSignal(false);
  let page: HTMLElement | undefined;
  const measure = (): void => {
    if (page) setResults(measureFidelity(page));
  };
  const resultOf = (id: string) => results().find((r) => r.id === id);
  const allOk = () => results().length > 0 && results().every((r) => r.ok);

  return (
    <article
      class={outline() ? "lab-page rtx-lab-outline" : "lab-page"}
      ref={(el) => {
        page = el;
        // Measure once laid out, and again when the web fonts land.
        requestAnimationFrame(measure);
        document.fonts?.ready.then(() => requestAnimationFrame(measure));
      }}
    >
      <header>
        <p class="eyebrow">fidelity</p>
        <h1>The markers change nothing</h1>
        <p class="lede">
          Left: the plain render. Middle: the same equation with every term marked. Right: the two
          laid over each other in difference blend — solid black means pixel identity. The number is
          the largest glyph displacement the instrument found.
        </p>
      </header>

      <div class="lab-toolbar">
        <button type="button" class="btn btn-outline" onClick={measure}>
          measure again
        </button>
        <label class="check">
          <input
            type="checkbox"
            checked={outline()}
            onInput={(e) => setOutline(e.currentTarget.checked)}
          />
          outline the terms
        </label>
        <Show when={results().length > 0}>
          <span class={allOk() ? "rtx-lab-verdict ok" : "rtx-lab-verdict bad"}>
            {allOk() ? "all cases identical" : "a case differs"}
          </span>
        </Show>
      </div>

      <For each={CASES}>
        {(c) => {
          const clean = cleanTeX(c.pieces);
          return (
            <section class="rtx-lab-case" data-case={c.id}>
              <h2>
                {c.title}
                <Show when={resultOf(c.id)}>
                  {(r) => (
                    <span class={r().ok ? "rtx-lab-delta ok" : "rtx-lab-delta bad"}>
                      {r().leaves} glyphs · Δ {r().maxDelta}px
                    </span>
                  )}
                </Show>
              </h2>
              <div class="rtx-lab-triptych">
                <div class="rtx-lab-plain">
                  <TeX display tex={clean} />
                </div>
                <div class="rtx-lab-rich">
                  <RichTeX display>{toChildren(c.pieces)}</RichTeX>
                </div>
                <div class="rtx-lab-diff">
                  <div class="rtx-lab-diff-a">
                    <TeX display tex={clean} />
                  </div>
                  <div class="rtx-lab-diff-b">
                    <RichTeX display>{toChildren(c.pieces)}</RichTeX>
                  </div>
                </div>
              </div>
              <pre class="rtx-lab-src">{clean}</pre>
            </section>
          );
        }}
      </For>
    </article>
  );
}
