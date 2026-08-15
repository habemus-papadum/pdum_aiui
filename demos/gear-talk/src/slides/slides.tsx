/**
 * slides.tsx — the six slides of "The Involute Gear", each an ordinary Solid
 * component reading the talk's cells and controls (pure readers — the deck
 * knows only the ordered list at the bottom).
 *
 * What each one exercises in the framework, deliberately:
 *  - title     — the bobbing cue; a rAF island parked via `useSlide().active`
 *  - involute  — the Lens, tier 2 AND 3: the detail's pressure-angle slider
 *                writes the talk's OWN control, so the change persists into
 *                every later figure (the folded-into-the-graph claim, live)
 *  - anatomy   — Lens terms inline in prose; shared cells re-read
 *  - mesh      — controls on the slide (toggle + slider), gated animation
 *  - design    — cells as readouts; a definition Lens with a live number
 *  - colophon  — a cross-demo link (the shell's interceptor keeps the turn)
 *
 * Previews (the HUD thumbnails) live in ./previews.tsx — cheap and pure.
 */

import { Lens, useSlide } from "@habemus-papadum/aiui-slides";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { graph } from "../model/graph";
import { addendum, dedendum, pressureAngle, rpm, running, teethA, teethB } from "../model/store";
import { AnatomySvg, InvoluteSvg, MeshSvg } from "../ui/figures";
import { useSpin } from "../ui/use-spin";

const RPM_TO_RAD = (2 * Math.PI) / 60;

// --- 1 · title ---------------------------------------------------------------

export function TitleSlide(): JSX.Element {
  const slide = useSlide();
  // A slow, steady turn behind the type — parked the moment you scroll on.
  const theta = useSpin(
    () => 0.35,
    () => slide.active(),
  );
  return (
    <div class="talk-slide talk-title">
      <div class="talk-title-backdrop">
        <CellView of={graph().scene} label="title mesh">
          {(s) => (
            <MeshSvg
              a={s().a}
              b={s().b}
              mesh={s().mesh}
              thetaA={theta()}
              class="talk-title-mesh"
              label="two involute gears, slowly meshing"
            />
          )}
        </CellView>
      </div>
      <p class="talk-kicker">an aiui talk</p>
      <h1>The Involute Gear</h1>
      <p class="talk-sub">
        why nearly every gearbox on earth trusts one curve — told in five viewport-sized ideas.
        Scroll, or press <kbd>o</kbd> for the overview.
      </p>
    </div>
  );
}

// --- 2 · why the involute ------------------------------------------------------

function LoaDetail(): JSX.Element {
  return (
    <div class="talk-lens-detail">
      <p>
        Involute flanks touch along one FIXED line — tangent to both base circles. The contact force
        never changes direction, so the tooth load is steady and the velocity ratio exact. Drag φ:
        the line tilts, the involutes regenerate.
      </p>
      <ControlSlider of={pressureAngle} label="pressure angle φ" format={(v) => `${v}°`} />
      <CellView of={graph().scene} label="line of action">
        {(s) => (
          <MeshSvg
            a={s().a}
            b={s().b}
            mesh={s().mesh}
            thetaA={0.35}
            showLoa
            class="talk-lens-fig"
            label="the line of action between two meshing gears"
          />
        )}
      </CellView>
      <p class="talk-fine">
        This slider writes the talk's own <code>pressureAngle</code> control — close this popup and
        the anatomy and mesh slides will have already followed. One graph, many views.
      </p>
    </div>
  );
}

export function InvoluteSlide(): JSX.Element {
  return (
    <div class="talk-slide">
      <h2>Why the involute?</h2>
      <ul class="talk-points">
        <li>
          <strong>Conjugate action.</strong> Unwind a string from a circle and you get a flank whose
          meshing ratio is exact at every instant — no speed ripple, ever.
        </li>
        <li>
          <strong>One straight contact path.</strong> The teeth only ever touch on the{" "}
          <Lens
            label="the line of action"
            preview={() => (
              <div class="talk-peek">
                <InvoluteSvg
                  class="talk-peek-fig"
                  label="an involute unwinding from its base circle"
                />
                <p>
                  The involute is the unwinding string's tip; contact stays on the taut string — a
                  straight line tangent to both base circles. Click for the live construction.
                </p>
              </div>
            )}
            detail={LoaDetail}
          >
            line of action
          </Lens>
          , so the force direction is constant.
        </li>
        <li>
          <strong>Forgiving mounting.</strong> Push the centres apart and the ratio does not change
          — the involute's gift to every real, imperfect machine.
        </li>
      </ul>
    </div>
  );
}

// --- 3 · anatomy ---------------------------------------------------------------

function AddendumDetail(): JSX.Element {
  return (
    <div class="talk-lens-detail">
      <p>
        The addendum is how far the tooth rises above the pitch circle (in modules). Taller teeth
        stay in contact longer — and dig deeper toward the mating root.
      </p>
      <ControlSlider of={addendum} label="addendum" format={(v) => `${v.toFixed(2)} m`} />
      <CellView of={graph().gearA} label="tooth zoom">
        {(g) => <AnatomySvg gear={g()} zoom class="talk-lens-fig" label="one tooth, zoomed" />}
      </CellView>
    </div>
  );
}

function DedendumDetail(): JSX.Element {
  return (
    <div class="talk-lens-detail">
      <p>
        The dedendum is the root depth below the pitch circle — clearance for the other gear's
        addendum, at the price of a slimmer tooth base.
      </p>
      <ControlSlider of={dedendum} label="dedendum" format={(v) => `${v.toFixed(2)} m`} />
      <CellView of={graph().gearA} label="tooth zoom">
        {(g) => <AnatomySvg gear={g()} zoom class="talk-lens-fig" label="one tooth, zoomed" />}
      </CellView>
    </div>
  );
}

export function AnatomySlide(): JSX.Element {
  return (
    <div class="talk-slide talk-split">
      <div class="talk-split-fig">
        <CellView of={graph().gearA} label="anatomy">
          {(g) => (
            <AnatomySvg gear={g()} class="talk-fig" label="a gear with its construction circles" />
          )}
        </CellView>
      </div>
      <div class="talk-split-text">
        <h2>Anatomy of a tooth</h2>
        <p>
          Four circles carry the whole design: the <span class="fig-key fig-key-pitch">pitch</span>{" "}
          circle where the ratio lives, the <span class="fig-key fig-key-base">base</span> circle
          the involute unwinds from, and the tip and root circles set by the{" "}
          <Lens
            label="addendum"
            preview={() => (
              <div class="talk-peek">
                <p>
                  Tip height above the pitch circle, in modules (standard: 1.0). Click to move it.
                </p>
              </div>
            )}
            detail={AddendumDetail}
          >
            addendum
          </Lens>{" "}
          and{" "}
          <Lens
            label="dedendum"
            preview={() => (
              <div class="talk-peek">
                <p>Root depth below the pitch circle (standard: 1.25 m). Click to move it.</p>
              </div>
            )}
            detail={DedendumDetail}
          >
            dedendum
          </Lens>
          .
        </p>
        <p class="talk-fine">
          The pressure angle you may have moved a slide ago is already shaping this wheel.
        </p>
      </div>
    </div>
  );
}

// --- 4 · the mesh, in motion ----------------------------------------------------

export function MeshSlide(): JSX.Element {
  const slide = useSlide();
  const theta = useSpin(
    () => rpm.get() * RPM_TO_RAD,
    () => slide.active() && running.get(),
  );
  return (
    <div class="talk-slide">
      <h2>The mesh, in motion</h2>
      <div class="talk-stage">
        <CellView of={graph().scene} label="mesh">
          {(s) => (
            <MeshSvg
              a={s().a}
              b={s().b}
              mesh={s().mesh}
              thetaA={theta()}
              showLoa
              showContacts
              class="talk-fig"
              label="the meshing pair with its live contact points"
            />
          )}
        </CellView>
      </div>
      <div class="talk-controls">
        <ControlToggle of={running} label={running.get() ? "pause" : "play"} />
        <ControlSlider of={rpm} label="speed" format={(v) => `${v} rpm`} />
      </div>
      <p class="talk-fine">
        Watch the contact points: they are born on one end of the line of action, ride it, and die
        at the other. Leave this slide and the animation parks itself.
      </p>
    </div>
  );
}

// --- 5 · designing a pair --------------------------------------------------------

function ContactRatioDetail(): JSX.Element {
  return (
    <div class="talk-lens-detail">
      <p>
        Contact ratio = path-of-contact length ÷ base pitch: the average number of tooth pairs
        carrying load. Below ~1.2 the handoff gets noisy; raise teeth counts (or the addendum) to
        buy margin.
      </p>
      <CellView of={graph().mesh} label="contact ratio">
        {(m) => <p class="talk-big-number">{m().contactRatio.toFixed(2)}</p>}
      </CellView>
    </div>
  );
}

export function DesignSlide(): JSX.Element {
  return (
    <div class="talk-slide talk-split">
      <div class="talk-split-text">
        <h2>Designing a pair</h2>
        <div class="talk-controls talk-controls-col">
          <ControlSlider of={teethA} label="teeth · A" format={(v) => `${v}`} />
          <ControlSlider of={teethB} label="teeth · B" format={(v) => `${v}`} />
        </div>
        <CellView of={graph().mesh} label="readouts">
          {(m) => (
            <div class="talk-readouts">
              <div>
                <span class="talk-rd-num">{m().ratio.toFixed(2)}:1</span>
                <span class="talk-rd-lbl">gear ratio</span>
              </div>
              <div>
                <span class="talk-rd-num">
                  <Lens label="contact ratio" detail={ContactRatioDetail}>
                    {m().contactRatio.toFixed(2)}
                  </Lens>
                </span>
                <span class="talk-rd-lbl">contact ratio</span>
              </div>
              <div>
                <span class="talk-rd-num">{m().center.toFixed(0)}</span>
                <span class="talk-rd-lbl">centre (mm)</span>
              </div>
            </div>
          )}
        </CellView>
      </div>
      <div class="talk-split-fig">
        <CellView of={graph().scene} label="pair">
          {(s) => (
            <MeshSvg
              a={s().a}
              b={s().b}
              mesh={s().mesh}
              thetaA={0.6}
              class="talk-fig"
              label="the designed pair"
            />
          )}
        </CellView>
      </div>
    </div>
  );
}

// --- 6 · colophon ----------------------------------------------------------------

export function ColophonSlide(): JSX.Element {
  return (
    <div class="talk-slide talk-colophon">
      <h2>fin</h2>
      <ul class="talk-points">
        <li>
          This deck is an ordinary aiui app: the current slide is a <em>control</em>, so an agent
          can drive it — try saying "next slide", or "set the pressure angle to 25".
        </li>
        <li>
          Every figure reads one shared cell graph; the Lens popups write the same controls the
          slides read. Nothing here is a screenshot.
        </li>
        <li>
          Want the full studio? Open the <a href="/gears">gears notebook</a> — the link is a
          client-side hop, your intent turn survives it.
        </li>
      </ul>
      <p class="talk-fine">
        built with <code>@habemus-papadum/aiui-slides</code> · press <kbd>o</kbd> for the overview ·{" "}
        <a href="https://github.com/habemus-papadum/pdum_aiui">pdum_aiui</a>
      </p>
    </div>
  );
}
