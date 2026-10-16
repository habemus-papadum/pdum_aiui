/**
 * Derivation.tsx — completing the square, one step at a time. The equation's
 * STRUCTURE changes with the step (the reactive-text level), while each term
 * keeps its id, so its color follows it from `bx` to `(b/a)x`; the terms the
 * step touched are lit; under every term, its value at the + root — the left
 * and right sides agree at every step, which is the whole point of a
 * derivation. The formula at the bottom is reactive text: move a, b, c and
 * its numbers move.
 */
import { ControlSlider } from "@habemus-papadum/aiui-viz";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { graph } from "../../model/graph";
import { fmt, STEPS, substitutedFormula } from "../../model/quadratic";
import { qa, qb, qc, step } from "../../model/store";
import { HUE_Q } from "../hues";

export function Derivation(): JSX.Element {
  const current = () => STEPS[step.get()] ?? (STEPS[0] as (typeof STEPS)[number]);
  const evaluation = () => graph().derivation.latest();
  const termValue = (id: string) => evaluation()?.values[id];
  const params = () => ({ a: qa.get(), b: qb.get(), c: qc.get() });
  const go = (delta: number) =>
    step.set(Math.max(0, Math.min(STEPS.length - 1, step.get() + delta)));

  const ValueNote = (p: { id: string }) => (
    <span class="rtx-lab-value numeric" data-term={p.id}>
      {(() => {
        const v = termValue(p.id);
        return v === undefined || Number.isNaN(v) ? "—" : fmt(v).replace("\\text{—}", "—");
      })()}
    </span>
  );

  return (
    <article class="lab-page">
      <header>
        <p class="eyebrow">derivation</p>
        <h1>Every step evaluated</h1>
        <p class="lede">
          Seven steps from ax² + bx + c = 0 to the quadratic formula. A term keeps its color through
          the derivation; the terms a step touched are lit; under each term is its value at the +
          root for the a, b, c you set — and the two sides agree at every step.
        </p>
      </header>

      <div class="lab-toolbar">
        <button
          type="button"
          class="btn btn-outline"
          disabled={step.get() === 0}
          onClick={() => go(-1)}
        >
          ← previous
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={step.get() === STEPS.length - 1}
          onClick={() => go(1)}
        >
          next →
        </button>
        <ControlSlider of={step} label="step" class="slider-compact" />
        <ControlSlider of={qa} label="a" class="slider-compact" />
        <ControlSlider of={qb} label="b" class="slider-compact" />
        <ControlSlider of={qc} label="c" class="slider-compact" />
      </div>

      <p class="rtx-lab-rule">
        <span class="eyebrow">
          step {step.get() + 1} of {STEPS.length}
        </span>
        <Show when={current().rule} fallback={<span>the equation</span>}>
          {(r) => <span>{r()}</span>}
        </Show>
      </p>

      <RichTeX display class="rtx-lab-eq rtx-lab-eq-steps">
        {current().pieces.map((p) =>
          typeof p === "string" ? (
            p
          ) : (
            <Term
              id={p.id}
              color={HUE_Q[p.id]}
              active={current().focus.includes(p.id)}
              note={<ValueNote id={p.id} />}
            >
              {p.tex}
            </Term>
          ),
        )}
      </RichTeX>

      <p class="small muted rtx-lab-sides">
        <Show
          when={!Number.isNaN(evaluation()?.x ?? Number.NaN)}
          fallback={<span>no real root for these coefficients (b² − 4ac &lt; 0)</span>}
        >
          <span>
            left side {fmt(evaluation()?.left ?? Number.NaN)} · right side{" "}
            {fmt(evaluation()?.right ?? Number.NaN)} · at x₊ = {fmt(evaluation()?.x ?? Number.NaN)}
          </span>
        </Show>
      </p>

      <RichTeX display class="rtx-lab-eq rtx-lab-eq-formula">
        {substitutedFormula(params())}
      </RichTeX>
    </article>
  );
}
