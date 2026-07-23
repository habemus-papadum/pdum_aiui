/**
 * App.tsx — the page (playbook layer 4). Overview first: the strand on the
 * bench with every control that moves it, then the alphabet that explains the
 * marks, then the notation set in running text.
 */
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { Repeat, Show } from "solid-js";
import { parseSequence } from "../model/dna";
import type { Helix, Loop } from "../model/fold";
import { EXAMPLES, flipStrand, graph, loadExample, MAX_FOLD } from "../model/graph";
import {
  foldSize,
  glyphSize,
  minHelix,
  minLoop,
  rotatePartner,
  sequence,
  showLetters,
} from "../model/store";
import { Duplex } from "./Duplex";
import { FoldFigure } from "./FoldFigure";
import { Glyph, Strand } from "./Glyph";
import { GlyphKey, PairDemo } from "./GlyphKey";

const EXAMPLE_KEYS = Object.keys(EXAMPLES);

/** Narrow the folded cell's union to the case that actually has a structure.
 *  The `<Show>` above already guarantees it; this tells the compiler so. */
function foldOf<T extends { tooLong: boolean }>(v: T): Extract<T, { tooLong: false }> {
  return v as Extract<T, { tooLong: false }>;
}

function describeHelices(hs: Helix[]): string {
  if (hs.length === 0) return "no helices";
  const lengths = hs.map((h) => h.length).join(", ");
  return `${hs.length} ${hs.length === 1 ? "helix" : "helices"} (${lengths} pairs)`;
}

function describeLoops(ls: Loop[]): string {
  const counts = new Map<string, number>();
  for (const l of ls) {
    if (l.kind === "stack" || l.kind === "exterior") continue;
    counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return "no loops";
  return [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
}

function SequenceField() {
  return (
    <label class="seq-field">
      <span class="seq-label">strand 5′→3′</span>
      <input
        class="seq-input"
        data-control={sequence.name}
        value={sequence.get()}
        spellcheck={false}
        autocapitalize="characters"
        onInput={(e) => sequence.set(e.currentTarget.value)}
        aria-label="DNA sequence"
      />
    </label>
  );
}

function Examples() {
  return (
    <div class="examples">
      <Repeat count={EXAMPLE_KEYS.length}>
        {(i) => {
          const key = () => EXAMPLE_KEYS[i];
          return (
            <button
              type="button"
              class="btn btn-outline"
              title={EXAMPLES[key()].note}
              onClick={() => loadExample(key())}
            >
              {EXAMPLES[key()].label}
            </button>
          );
        }}
      </Repeat>
      <button type="button" class="btn" onClick={() => flipStrand()}>
        reverse-complement it
      </button>
    </div>
  );
}

function Readout() {
  return (
    <CellView of={graph().strand}>
      {(v) => (
        <div class="readout" data-cell="strand">
          <Show when={v().bases.length > 0} fallback={<span class="muted">no bases yet</span>}>
            <span class={v().palindrome ? "flag flag-on" : "flag"}>
              {v().palindrome ? "reverse palindrome" : "not a palindrome"}
            </span>
            <span class="muted">
              {v().bases.length} bases · {Math.round(v().gc * 100)}% GC
              <Show when={v().stem > 0 && !v().palindrome}>
                {" "}
                · {v().stem}-base stem, {v().bases.length - 2 * v().stem}-base loop
              </Show>
            </span>
            <span class="muted">
              partner 5′→3′: <code>{v().partner}</code>
            </span>
          </Show>
          <Show when={v().rejected.length > 0}>
            <span class="warn">ignored {v().rejected.join(" ")}</span>
          </Show>
        </div>
      )}
    </CellView>
  );
}

export function App() {
  return (
    <div class="app">
      <header class="app-head">
        <h1 class="app-title">DNA scripts</h1>
        <p class="lede">
          A notation where the shapes do the work letters cannot: complementary bases interlock, and
          a strand set against its reverse complement — turned end over end — zips shut.
        </p>
      </header>

      <section id="bench">
        <h2>The bench</h2>
        <SequenceField />
        <Examples />
        <div class="knobs">
          <ControlToggle of={rotatePartner} label="turn the partner 180°" />
          <ControlToggle of={showLetters} label="show letters" />
          <ControlSlider of={glyphSize} label="size" />
        </div>

        <CellView of={graph().duplex}>
          {(layout) => (
            <div class="figure-scroll" data-cell="duplex">
              <Duplex layout={layout()} size={glyphSize.get()} showLetters={showLetters.get()} />
            </div>
          )}
        </CellView>
        <Readout />

        <p class="note">
          Turn the partner off and it is written the ordinary way — its own 5′→3′, left to right.
          Nothing meshes, because that row is the same strand read the other way round. Turn it back
          on and every tooth finds its socket.
        </p>
      </section>

      <section id="alphabet">
        <h2>The alphabet</h2>
        <p>
          Three features carry the meaning. The <b>bump family</b> says which pair a base belongs to
          — round for A·T, angular for G·C. The <b>polarity</b> says which member: a tooth
          protrudes, its partner's socket receives it. The <b>solid half</b> is shared by both
          members of a pair, and it is what makes a duplex legible at arm's length.
        </p>
        <GlyphKey />

        <h3>The two pairs, meshed</h3>
        <p>
          Because complements share a solid half, turning one of them puts the two solids in
          different places: A·T ends up hollow through the middle, G·C solid across it. A GC-rich
          stretch is visibly denser — which is also the stretch that is harder to pull apart.
        </p>
        <div class="pair-row">
          <PairDemo base="A" />
          <PairDemo base="G" />
        </div>
      </section>

      <section id="folding">
        <h2>Folding</h2>
        <p>
          A duplex needs two strands. A <em>fold</em> needs only one: a strand pairs with itself
          wherever some stretch meets a later stretch that is its reverse complement. The fragment
          as a whole need not be a palindrome — only the two arms have to match, and whatever sits
          between them is left over as a loop. <b>arms zip</b> below is exactly that case:{" "}
          <code>GGGG</code> and <code>CCCC</code> close around an <code>ATTT</code> loop, and the
          twelve bases together are not a palindrome at all.
        </p>
        <p>
          Once the arms need not abut, finding the pairing stops being something you read off and
          becomes a search — so the fold is computed rather than declared. Try <b>not obvious</b> or{" "}
          <b>gnarly</b>: neither structure is one you would pick out by eye.
        </p>

        <div class="knobs">
          <ControlSlider of={minLoop} label="min loop" />
          <ControlSlider of={minHelix} label="min helix" />
          <ControlSlider of={foldSize} label="size" />
        </div>

        <CellView of={graph().folded}>
          {(v) => (
            <div data-cell="folded">
              <Show
                when={!v().tooLong}
                fallback={
                  <p class="warn">
                    {v().bases.length} bases — past the {MAX_FOLD}-base budget for folding on the
                    main thread. The search is O(n³); a worker would be the fix.
                  </p>
                }
              >
                <div class="figure-scroll fold-scroll">
                  <FoldFigure layout={foldOf(v()).layout} size={foldSize.get()} />
                </div>
                <div class="readout">
                  <code class="structure">{foldOf(v()).structure}</code>
                </div>
                <div class="readout">
                  <span class="muted">
                    {foldOf(v()).paired} of {v().bases.length} bases paired ·{" "}
                    {describeHelices(foldOf(v()).helices)} · {describeLoops(foldOf(v()).loops)}
                  </span>
                  <Show when={foldOf(v()).collisions.length > 0}>
                    <span class="warn">
                      {foldOf(v()).collisions.length} branch collisions — the layout does no
                      relaxation pass, so this drawing overlaps itself
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </CellView>

        <p class="note">
          The pairing comes from Nussinov maximum-pairing, weighted so G·C outscores A·T, with
          helices shorter than <b>min helix</b> thrown away. That is <em>not</em> free-energy
          minimisation — there are no stacking or loop-entropy parameters here — so it will
          sometimes propose a structure no real molecule would adopt. It earns its place by making
          the notation work on arbitrary input, not by predicting biology.
        </p>
        <p class="note">
          Layout is the classic radiate construction: helices are straight ladders — the same duplex
          as above, rotated — and each loop is a circle whose radius solves{" "}
          <code>nH·2asin(H/2r) + nW·2asin(W/2r) = 2π</code>, so neighbouring bases land exactly one
          step apart. Branches leave along the outward radius. There is no relaxation pass, so
          crowded structures can still overlap; when they do, the readout says so rather than
          presenting the tangle as fact.
        </p>
      </section>

      <section id="inline">
        <h2>In running text</h2>
        <p>
          The glyphs are sized in <code>em</code>, so they set inline at whatever size the
          surrounding prose is. The EcoRI site <Strand seq={parseSequence("GAATTC").bases} /> is a
          palindrome; <Strand seq={parseSequence("ATGGCA").bases} /> is not. A single{" "}
          <Glyph base="G" /> can be named mid-sentence the way a letter can, and a run of them butts
          together into one ribbon rather than a row of separate tiles.
        </p>
        <p class="note">
          Whether this ends up as an SVG component or a real font is still open — but the two-tone
          fill is doing too much work to give up, and colour is exactly what a plain font cannot
          carry, so it is SVG for now.
        </p>
      </section>
    </div>
  );
}
