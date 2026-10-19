import { bridgeEffect, CellView, ControlToggle, elementWidth } from "@habemus-papadum/aiui-viz";
import { createKnobs, KnobReadout } from "@habemus-papadum/aiui-viz/site/knob";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site/rich-tex";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { graph } from "../model/graph";
import { BEAM_SPAN, type BeamFeature, type BeamResult, beamViewport } from "../model/statics";
import {
  beamSelection,
  centerLoad,
  freeBody,
  load,
  loadPosition,
  resetBeam,
  selectBeam,
  staticsScope,
} from "../model/statics-store";

const forceText = (value: number) => `${value.toFixed(2)} N`;
const positionText = (percent: number) => `${((BEAM_SPAN * percent) / 100).toFixed(2)} m`;
const SUPPORTS = ["left", "right"] as const;
interface Attention {
  active: BeamFeature | null;
  hover: (feature: BeamFeature | null) => void;
  select: (feature: BeamFeature) => void;
}

function VerticalForce(props: { x: number; from: number; to: number }) {
  const head = () => Math.min(8, Math.abs(props.from - props.to));
  const back = () => props.to + Math.sign(props.from - props.to) * head();
  return (
    <>
      <line class="svg-statics-force" x1={props.x} x2={props.x} y1={props.from} y2={props.to} />
      <path
        class="svg-statics-arrowhead"
        d={`M${props.x} ${props.to} L${props.x - head() * 0.65} ${back()} H${props.x + head() * 0.65} Z`}
      />
    </>
  );
}

function BeamDrawing(props: Attention & { beam: BeamResult }) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  const hostWidth = elementWidth(host);
  const view = createMemo(() => beamViewport(Math.max(280, hostWidth() || 850)));
  const beam = createMemo(() => props.beam);
  const forceScale = 0.7;
  const loadX = createMemo(() => view().left + (view().span * beam().positionPercent) / 100);
  const loadTop = createMemo(() => view().beamY - 8 - beam().load * forceScale);
  const labelX = createMemo(() => Math.max(8, Math.min(view().width - 128, loadX() - 60)));
  const knobs = createKnobs();
  let positionHandle: SVGGElement | undefined;
  let forceHandle: SVGGElement | undefined;
  let measureFrame = 0;
  let placeFrame = 0;
  let boundHost: HTMLElement | undefined;
  let boundSpan = 0;
  bridgeEffect(
    () => ({ element: host(), span: view().span, model: beam() }),
    ({ element, span }) => {
      if (!element || !positionHandle || !forceHandle) return;
      if (boundHost !== element || boundSpan !== span) {
        knobs.attach(element);
        // The shared horizontal scrub now follows diagram geometry: one full span = 100%.
        knobs.bind(positionHandle, { control: loadPosition, span, format: positionText });
        knobs.bind(forceHandle, { control: load, format: forceText });
        boundHost = element;
        boundSpan = span;
      }
      if (!placeFrame)
        placeFrame = requestAnimationFrame(() => {
          placeFrame = 0;
          knobs.place();
        });
    },
    { scope: staticsScope, name: "diagram-knobs" },
  );
  onCleanup(() => {
    cancelAnimationFrame(measureFrame);
    cancelAnimationFrame(placeFrame);
  });
  return (
    <div
      class="svg-statics-plate"
      ref={(element) => {
        measureFrame = requestAnimationFrame(() => {
          elementWidth(element)();
          setHost(element);
        });
      }}
    >
      <svg
        viewBox={`0 0 ${view().width} ${view().height}`}
        aria-label="Beam on two supports with a draggable downward load"
      >
        <title>
          Drag the load arrow along the beam. Scrub W to change its force. Reaction arrows show the
          calculated upward forces.
        </title>
        <text class="svg-statics-hint" x="20" y="25">
          {freeBody.get() ? "FREE-BODY VIEW" : "PIN A · ROLLER B"}
        </text>
        <text class="svg-statics-hint" x={view().width - 20} y="25" text-anchor="end">
          DRAG THE LOAD ARROW
        </text>
        <rect
          class="svg-statics-beam"
          x={view().left}
          y={view().beamY - 6}
          width={view().span}
          height="12"
        />
        <For each={SUPPORTS}>
          {(side) => {
            const x = () => (side === "left" ? view().left : view().right);
            const reaction = () => (side === "left" ? beam().left : beam().right);
            const tail = () => view().beamY + 8 + reaction() * forceScale;
            const name = side === "left" ? "A" : "B";
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG support and force glyphs share a selectable semantic target.
              <g
                class={`svg-statics-reaction ${side}`}
                data-beam-feature={side}
                data-active={props.active === side ? "true" : undefined}
                role="button"
                tabindex="0"
                aria-label={`Reaction at ${name}: ${forceText(reaction())}`}
                onPointerEnter={() => props.hover(side)}
                onPointerLeave={() => props.hover(null)}
                onFocus={() => props.hover(side)}
                onBlur={() => props.hover(null)}
                onClick={() => props.select(side)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.select(side);
                  }
                }}
              >
                <Show when={!freeBody.get()}>
                  <g
                    class="svg-statics-support"
                    transform={`translate(${x()} ${view().beamY + 8})`}
                  >
                    <path d="M0 0 L-20 28 H20 Z" />
                    <Show
                      when={side === "right"}
                      fallback={
                        <path d="M-27 33 H27 M-22 33 l-7 7 M-8 33 l-7 7 M6 33 l-7 7 M20 33 l-7 7" />
                      }
                    >
                      <circle cx="-11" cy="34" r="4" />
                      <circle cx="11" cy="34" r="4" />
                      <path d="M-27 41 H27" />
                    </Show>
                  </g>
                </Show>
                <line
                  class="svg-statics-hit"
                  x1={x()}
                  x2={x()}
                  y1={view().beamY + 8}
                  y2={Math.max(tail(), view().beamY + 70)}
                />
                <Show
                  when={reaction() > 0}
                  fallback={
                    <circle class="svg-statics-zero" cx={x()} cy={view().beamY + 8} r="5" />
                  }
                >
                  <VerticalForce x={x()} from={tail()} to={view().beamY + 8} />
                </Show>
                <text
                  class="svg-statics-support-name"
                  x={x() + (side === "left" ? -15 : 15)}
                  y={view().beamY + 23}
                  text-anchor={side === "left" ? "end" : "start"}
                >
                  {name}
                </text>
                <text
                  class="svg-statics-force-label"
                  x={x() + (side === "left" ? 12 : -12)}
                  y={
                    Math.max(view().beamY + 85, tail() + 22) +
                    (side === "right" && view().span < 300 ? 24 : 0)
                  }
                  text-anchor={side === "left" ? "start" : "end"}
                >
                  R{name} = {forceText(reaction())}
                </text>
              </g>
            );
          }}
        </For>
        <g
          ref={positionHandle}
          class="svg-statics-load"
          data-beam-feature="position"
          data-active={props.active === "position" || props.active === "load" ? "true" : undefined}
          role="slider"
          tabindex="0"
          aria-label="Load position"
          aria-valuenow={beam().positionPercent}
          aria-valuemin={loadPosition.meta.min}
          aria-valuemax={loadPosition.meta.max}
          onPointerEnter={() => props.hover("position")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("position")}
          onBlur={() => props.hover(null)}
          onPointerDown={() => props.select("position")}
        >
          <line
            class="svg-statics-hit"
            x1={loadX()}
            x2={loadX()}
            y1={loadTop() - 8}
            y2={view().beamY}
          />
          <VerticalForce x={loadX()} from={loadTop()} to={view().beamY - 8} />
          <circle class="svg-statics-load-grip" cx={loadX()} cy={loadTop()} r="7" />
        </g>
        <g
          ref={forceHandle}
          class="svg-statics-knob"
          data-beam-feature="load"
          data-active={props.active === "load" ? "true" : undefined}
          role="slider"
          tabindex="0"
          aria-label="Downward load"
          aria-valuenow={beam().load}
          aria-valuemin={load.meta.min}
          aria-valuemax={load.meta.max}
          transform={`translate(${labelX()} ${loadTop() - 38})`}
          onPointerEnter={() => props.hover("load")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("load")}
          onBlur={() => props.hover(null)}
          onPointerDown={() => props.select("load")}
        >
          <rect width="120" height="30" />
          <text x="8" y="21">
            W = {beam().load} N
          </text>
        </g>
        <g
          class="svg-statics-dimension"
          data-active={props.active === "position" ? "true" : undefined}
          pointer-events="none"
        >
          <path
            d={`M${view().left} ${view().beamY - 30} H${loadX()} M${view().left} ${view().beamY - 35} v10 M${loadX()} ${view().beamY - 35} v10`}
          />
          <text
            x={Math.max(view().left + 40, (view().left + loadX()) / 2)}
            y={view().beamY - 42}
            text-anchor="middle"
          >
            x = {beam().distance.toFixed(2)} m
          </text>
        </g>
        {/* biome-ignore lint/a11y/useSemanticElements: SVG dimension selection links to its equation term. */}
        <g
          class="svg-statics-dimension"
          data-beam-feature="span"
          data-active={props.active === "span" ? "true" : undefined}
          role="button"
          tabindex="0"
          aria-label="Support span L equals four metres"
          onPointerEnter={() => props.hover("span")}
          onPointerLeave={() => props.hover(null)}
          onClick={() => props.select("span")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.select("span");
            }
          }}
        >
          <path
            d={`M${view().left} 431 H${view().right} M${view().left} 426 v10 M${view().right} 426 v10`}
          />
          <text x={view().width / 2} y="454" text-anchor="middle">
            L = {beam().span.toFixed(1)} m
          </text>
        </g>
      </svg>
      <KnobReadout of={knobs} />
    </div>
  );
}

export function StaticsLab() {
  const [hovered, setHovered] = createSignal<BeamFeature | null>(null);
  const active = () => hovered() ?? beamSelection.get();
  const select = (feature: BeamFeature) => selectBeam.run({ feature });
  const hover = (feature: BeamFeature) => (value: boolean) => setHovered(value ? feature : null);
  return (
    <section class="svg-statics" aria-label="Beam statics experiment">
      <div class="svg-statics-toolbar">
        <ControlToggle of={freeBody} label="Free-body view" />
        <button type="button" class="btn btn-outline" onClick={() => centerLoad.run()}>
          Centre load
        </button>
        <button type="button" class="btn btn-outline" onClick={() => resetBeam.run()}>
          Reset beam
        </button>
        <p>Move the load toward a support and watch that support carry more.</p>
      </div>
      <CellView of={graph().statics}>
        {(beam) => (
          <>
            <div class="svg-statics-layout">
              <div>
                <div class="svg-lab-figure-heading">
                  <span>04 / load + reactions</span>
                  <span>forces in N · lengths in m</span>
                </div>
                <BeamDrawing beam={beam()} active={active()} hover={setHovered} select={select} />
                <p class="svg-lab-caption">
                  Drag the arrow horizontally to move the load. Scrub W to change its magnitude.
                  Arrow keys work on both.
                </p>
              </div>
              <aside class="svg-statics-readings">
                <p class="svg-lab-eyebrow">Support reactions</p>
                <div class="svg-statics-reading">
                  <span class="svg-statics-support-caption">A · pin</span>
                  <output data-reaction="left">{forceText(beam().left)}</output>
                </div>
                <div class="svg-statics-reading">
                  <span class="svg-statics-support-caption">B · roller</span>
                  <output data-reaction="right">{forceText(beam().right)}</output>
                </div>
                <p>
                  {beam().positionPercent === 50
                    ? "The load is centred. Each support carries half."
                    : beam().positionPercent === 0
                      ? "The load is over A. B’s vertical reaction is zero."
                      : beam().positionPercent === 100
                        ? "The load is over B. A’s vertical reaction is zero."
                        : `The load is ${beam().distance.toFixed(2)} m from A.`}
                </p>
                <p class="svg-lab-caption">
                  Upward reactions balance the downward load. Select a reaction arrow or its
                  equation term to follow the same force.
                </p>
              </aside>
            </div>
            <div class="svg-statics-equations">
              <div class="svg-statics-equation">
                <p class="svg-lab-eyebrow">Vertical force balance</p>
                <RichTeX display>
                  <Term
                    id="beam-left-force"
                    active={active() === "left"}
                    onHover={hover("left")}
                    onClick={() => select("left")}
                  >
                    {"R_A"}
                  </Term>
                  {" + "}
                  <Term
                    id="beam-right-force"
                    active={active() === "right"}
                    onHover={hover("right")}
                    onClick={() => select("right")}
                  >
                    {"R_B"}
                  </Term>
                  {" - "}
                  <Term
                    id="beam-load-force"
                    control={load}
                    format={forceText}
                    active={active() === "load"}
                    onHover={hover("load")}
                    onClick={() => select("load")}
                  >
                    W
                  </Term>
                  {" = 0"}
                </RichTeX>
                <p class="svg-statics-substitution">
                  {beam().left.toFixed(2)} + {beam().right.toFixed(2)} − {beam().load.toFixed(1)} =
                  0 N
                </p>
              </div>
              <div class="svg-statics-equation">
                <p class="svg-lab-eyebrow">Moment balance about A</p>
                <RichTeX display>
                  <Term
                    id="beam-right-moment"
                    active={active() === "right"}
                    onHover={hover("right")}
                    onClick={() => select("right")}
                  >
                    {"R_B"}
                  </Term>
                  {"\\,"}
                  <Term
                    id="beam-span"
                    active={active() === "span"}
                    onHover={hover("span")}
                    onClick={() => select("span")}
                  >
                    L
                  </Term>
                  {" - "}
                  <Term
                    id="beam-load-moment"
                    control={load}
                    format={forceText}
                    active={active() === "load"}
                    onHover={hover("load")}
                    onClick={() => select("load")}
                  >
                    W
                  </Term>
                  {"\\,"}
                  <Term
                    id="beam-position"
                    control={loadPosition}
                    format={positionText}
                    active={active() === "position"}
                    onHover={hover("position")}
                    onClick={() => select("position")}
                  >
                    x
                  </Term>
                  {" = 0"}
                </RichTeX>
                <p class="svg-statics-substitution">
                  {beam().right.toFixed(2)} × {beam().span.toFixed(1)} − {beam().load.toFixed(1)} ×{" "}
                  {beam().distance.toFixed(2)} = 0 N·m
                </p>
              </div>
            </div>
            <p class="svg-lab-caption">
              Scrub W in either equation, or x in the moment equation. These are the same controls
              as the load’s label and arrow. Values above are rounded.
            </p>
          </>
        )}
      </CellView>
      <p class="svg-statics-scope">
        Ideal rigid, weightless beam. A is a pin; B is a frictionless roller. One vertical point
        load stays between the supports, so A’s horizontal reaction is zero. This shows equilibrium
        forces, without bending, deformation or motion.
      </p>
    </section>
  );
}
