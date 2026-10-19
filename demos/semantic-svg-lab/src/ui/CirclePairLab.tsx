import { bridgeEffect, CellView, ControlSlider, elementWidth } from "@habemus-papadum/aiui-viz";
import { createKnobs, KnobReadout } from "@habemus-papadum/aiui-viz/site/knob";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site/rich-tex";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  type PairFeature,
  type PairPoint,
  type PairPose,
  type PairResult,
  type PairViewport,
  pairFromScreen,
  pairToScreen,
  pairViewport,
} from "../model/circle-pair";
import {
  alignPair,
  holdPair,
  movePair,
  pairScope,
  pairSelection,
  pairZoom,
  radiusA,
  radiusB,
  resetPair,
  selectPair,
  setPairPose,
  touchPair,
} from "../model/circle-pair-store";
import { graph } from "../model/graph";

const mm = (value: number) => `${value.toFixed(1)} mm`;
const samePoint = (a: PairPoint, b: PairPoint) => a.x === b.x && a.y === b.y;
const CROSSINGS = [0, 1];
interface Attention {
  active: PairFeature | null;
  hover: (feature: PairFeature | null) => void;
  select: (feature: PairFeature) => void;
}
function pairDescription(pair: PairResult): string {
  if (pair.relation === "coincident")
    return "The boundaries coincide. There is no unique contact point or centre-line normal.";
  if (!pair.normal)
    return "The centres coincide. One circle is inside the other; the centre-line normal is undefined.";
  if (pair.relation === "contained")
    return `${pair.radiusA > pair.radiusB ? "B is inside A" : "A is inside B"}. The boundaries do not touch.`;
  if (pair.relation === "internal-tangent")
    return "One circle is inside the other. Their boundaries touch at C; the external gap remains negative.";
  if (pair.relation === "intersecting")
    return "The boundaries cross at the two marked points. The external gap is negative.";
  if (pair.relation === "external-tangent")
    return "The facing points coincide at C. The normal and common tangent rotate together.";
  return "The facing points are separated. Touch once to see their common tangent at contact.";
}
const relationName: Record<PairResult["relation"], string> = {
  separated: "Separated",
  "external-tangent": "External tangency",
  intersecting: "Intersecting",
  "internal-tangent": "Internal tangency",
  contained: "Contained",
  coincident: "Coincident circles",
};

function PairDrawing(props: Attention & { pair: PairResult }) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  const hostWidth = elementWidth(host);
  const view = createMemo(() =>
    pairViewport(Math.max(280, hostWidth() || 850), 500, pairZoom.get()),
  );
  const pair = createMemo(() => props.pair);
  const a = createMemo(() => pairToScreen({ x: 0, y: 0 }, view()), { equals: samePoint });
  const b = createMemo(() => pairToScreen(pair().centerB, view()), { equals: samePoint });
  const ra = createMemo(() => pair().radiusA * view().scale);
  const rb = createMemo(() => pair().radiusB * view().scale);
  const pa = createMemo(() => pairToScreen(pair().facingA ?? { x: 0, y: 0 }, view()), {
    equals: samePoint,
  });
  const pb = createMemo(() => pairToScreen(pair().facingB ?? { x: 0, y: 0 }, view()), {
    equals: samePoint,
  });
  const contact = createMemo(() => pairToScreen(pair().contactPoint ?? { x: 0, y: 0 }, view()), {
    equals: samePoint,
  });
  const direction = createMemo(() => ({ x: pair().normal?.x ?? 0, y: -(pair().normal?.y ?? 0) }), {
    equals: samePoint,
  });
  const cross = createMemo(() => ({ x: -direction().y, y: direction().x }), { equals: samePoint });
  const showGap = () => pair().normal && ["separated", "intersecting"].includes(pair().relation);
  const knobs = createKnobs();
  let svg: SVGSVGElement | undefined;
  let knobA: SVGGElement | undefined;
  let knobB: SVGGElement | undefined;
  let measureFrame = 0;
  let boundHost: HTMLElement | undefined;
  bridgeEffect(
    () => host(),
    (element) => {
      if (!element || element === boundHost || !knobA || !knobB) return;
      knobs.attach(element);
      knobs.bind(knobA, { control: radiusA, format: mm });
      knobs.bind(knobB, { control: radiusB, format: mm });
      boundHost = element;
    },
    { scope: pairScope, name: "radius-knobs" },
  );
  let drag:
    | { pointer: number; press: PairPoint; initial: PairPoint; pose: PairPose; view: PairViewport }
    | undefined;
  onCleanup(() => {
    cancelAnimationFrame(measureFrame);
    drag = undefined;
  });
  function screen(event: { clientX: number; clientY: number }): PairPoint {
    const matrix = svg?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  }
  function start(event: PointerEvent) {
    if (event.button !== 0 || drag || !svg) return;
    event.preventDefault();
    event.stopPropagation();
    props.select("distance");
    drag = {
      pointer: event.pointerId,
      press: pairFromScreen(screen(event), view()),
      initial: pair().centerB,
      pose: { distance: pair().distance, angle: pair().angle },
      view: view(),
    };
    svg.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const p = pairFromScreen(screen(event), drag.view);
    movePair.run({
      x: drag.initial.x + p.x - drag.press.x,
      y: drag.initial.y + p.y - drag.press.y,
    });
  }
  function stop(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    if (cancel) setPairPose.run({ ...previous.pose });
    if (svg?.hasPointerCapture(previous.pointer)) svg.releasePointerCapture(previous.pointer);
  }
  return (
    <div
      class="svg-pair-plate"
      ref={(element) => {
        measureFrame = requestAnimationFrame(() => {
          elementWidth(element)();
          setHost(element);
        });
      }}
    >
      <svg
        ref={svg}
        viewBox={`0 0 ${view().width} ${view().height}`}
        aria-label="Fixed-centre circle A and draggable circle B"
        data-pair-relation={pair().relation}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (event.pointerId === drag?.pointer) stop();
        }}
        onPointerCancel={(event) => {
          if (event.pointerId === drag?.pointer) stop(true);
        }}
        onLostPointerCapture={() => {
          drag = undefined;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") stop(true);
        }}
      >
        <title>
          Drag B around A. Keep tangent to maintain external contact while changing bearing or
          either radius.
        </title>
        <text class="svg-pair-hint" x="18" y="24">
          A · FIXED CENTRE
        </text>
        <text class="svg-pair-hint" x={view().width - 18} y="24" text-anchor="end">
          {pair().held ? "EXTERNAL TANGENCY HELD" : "DRAG B"}
        </text>
        <circle
          class="svg-pair-circle a"
          data-active={props.active === "a" ? "true" : undefined}
          cx={a().x}
          cy={a().y}
          r={ra()}
        />
        <circle
          class="svg-pair-circle b"
          data-active={props.active === "b" ? "true" : undefined}
          data-coincident={pair().relation === "coincident" ? "true" : undefined}
          cx={b().x}
          cy={b().y}
          r={rb()}
        />
        <g
          class="svg-pair-distance"
          data-active={props.active === "distance" ? "true" : undefined}
          pointer-events="none"
        >
          <line x1={a().x} y1={a().y} x2={b().x} y2={b().y} />
          <Show when={pair().normal !== null}>
            <text
              x={(a().x + b().x) / 2 - cross().x * 26}
              y={(a().y + b().y) / 2 - cross().y * 26}
              text-anchor="middle"
            >
              d
            </text>
          </Show>
        </g>
        <g class="svg-pair-centres" pointer-events="none">
          <circle cx={a().x} cy={a().y} r="3" />
          <circle cx={b().x} cy={b().y} r="3" />
          <text x={a().x - 14} y={a().y - 12}>
            A
          </text>
          <text x={b().x + 10} y={b().y + 20}>
            B
          </text>
        </g>
        <Show when={showGap()}>
          <g
            class="svg-pair-gap"
            data-active={props.active === "gap" ? "true" : undefined}
            pointer-events="none"
          >
            <line x1={pa().x} y1={pa().y} x2={pb().x} y2={pb().y} />
            <circle cx={pa().x} cy={pa().y} r="4" />
            <circle cx={pb().x} cy={pb().y} r="4" />
            <text
              x={(pa().x + pb().x) / 2 + cross().x * 20}
              y={(pa().y + pb().y) / 2 + cross().y * 20}
              text-anchor="middle"
            >
              g
            </text>
          </g>
        </Show>
        <Show when={pair().normal !== null}>
          <g
            class="svg-pair-normal"
            data-active={props.active === "normal" ? "true" : undefined}
            pointer-events="none"
          >
            <line
              x1={a().x}
              y1={a().y}
              x2={a().x + direction().x * 42}
              y2={a().y + direction().y * 42}
            />
            <path
              d={`M${a().x + direction().x * 42} ${a().y + direction().y * 42} L${a().x + direction().x * 34 + cross().x * 4} ${a().y + direction().y * 34 + cross().y * 4} L${a().x + direction().x * 34 - cross().x * 4} ${a().y + direction().y * 34 - cross().y * 4} Z`}
            />
            <text
              x={a().x + direction().x * 30 - cross().x * 16}
              y={a().y + direction().y * 30 - cross().y * 16}
            >
              n
            </text>
          </g>
        </Show>
        <Show when={pair().contactPoint !== null}>
          <g
            class="svg-pair-tangent"
            data-active={props.active === "tangent" ? "true" : undefined}
            pointer-events="none"
          >
            <line
              x1={contact().x - cross().x * 58}
              y1={contact().y - cross().y * 58}
              x2={contact().x + cross().x * 58}
              y2={contact().y + cross().y * 58}
            />
            <circle cx={contact().x} cy={contact().y} r="5" />
            <text x={contact().x + cross().x * 64} y={contact().y + cross().y * 64}>
              t
            </text>
            <text x={contact().x + 10} y={contact().y - 12}>
              C
            </text>
          </g>
        </Show>
        <For each={CROSSINGS}>
          {(index) => (
            <Show when={pair().crossings[index]}>
              {(point) => (
                <circle
                  class="svg-pair-crossing"
                  cx={pairToScreen(point(), view()).x}
                  cy={pairToScreen(point(), view()).y}
                  r="4"
                />
              )}
            </Show>
          )}
        </For>
        {/* biome-ignore lint/a11y/useSemanticElements: This SVG hit region is the two-dimensional position control for B. */}
        <circle
          class="svg-pair-moving"
          data-pair-feature="moving"
          cx={b().x}
          cy={b().y}
          r={Math.max(22, rb())}
          role="button"
          tabindex="0"
          aria-label="Move circle B. Arrow keys move it; when tangent, Left and Right orbit it."
          onPointerDown={start}
          onPointerEnter={() => props.hover("distance")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("distance")}
          onBlur={() => props.hover(null)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            props.select("distance");
            if (pair().held) {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight")
                setPairPose.run({
                  distance: pair().distance,
                  angle:
                    pair().angle + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 10 : 1),
                });
            } else {
              const step = event.shiftKey ? 20 : 5;
              movePair.run({
                x:
                  pair().centerB.x +
                  (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
                y:
                  pair().centerB.y +
                  (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
              });
            }
          }}
        />
        <g
          ref={knobA}
          class="svg-pair-knob a"
          data-pair-feature="a"
          data-active={props.active === "a" ? "true" : undefined}
          transform={`translate(18 ${view().height - 46})`}
          role="slider"
          tabindex="0"
          aria-label="Radius A"
          aria-valuenow={pair().radiusA}
          aria-valuemin={radiusA.meta.min}
          aria-valuemax={radiusA.meta.max}
          onPointerEnter={() => props.hover("a")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("a")}
          onBlur={() => props.hover(null)}
          onPointerDown={() => props.select("a")}
        >
          <rect width="136" height="30" />
          <text x="8" y="21">
            rA = {mm(pair().radiusA)}
          </text>
        </g>
        <g
          ref={knobB}
          class="svg-pair-knob b"
          data-pair-feature="b"
          data-active={props.active === "b" ? "true" : undefined}
          transform={`translate(${view().width - 154} ${view().height - 46})`}
          role="slider"
          tabindex="0"
          aria-label="Radius B"
          aria-valuenow={pair().radiusB}
          aria-valuemin={radiusB.meta.min}
          aria-valuemax={radiusB.meta.max}
          onPointerEnter={() => props.hover("b")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("b")}
          onBlur={() => props.hover(null)}
          onPointerDown={() => props.select("b")}
        >
          <rect width="136" height="30" />
          <text x="8" y="21">
            rB = {mm(pair().radiusB)}
          </text>
        </g>
      </svg>
      <KnobReadout of={knobs} />
    </div>
  );
}

export function CirclePairLab() {
  const [hovered, setHovered] = createSignal<PairFeature | null>(null);
  const active = () => hovered() ?? pairSelection.get();
  const select = (feature: PairFeature) => selectPair.run({ feature });
  const hover = (feature: PairFeature) => (value: boolean) => setHovered(value ? feature : null);
  return (
    <section class="svg-pair" aria-label="Circle to circle contact experiment">
      <CellView of={graph().pair}>
        {(pair) => (
          <>
            <div class="svg-pair-toolbar">
              <button
                type="button"
                class="btn"
                disabled={!pair().normal}
                aria-pressed={pair().held ? "true" : "false"}
                onClick={() => holdPair.run({ enabled: !pair().held })}
              >
                {pair().held ? "Release tangency" : "Keep tangent"}
              </button>
              <button
                type="button"
                class="btn btn-outline"
                disabled={!pair().normal}
                onClick={() => touchPair.run()}
              >
                Touch once
              </button>
              <button type="button" class="btn btn-outline" onClick={() => alignPair.run()}>
                Align centres
              </button>
              <ControlSlider
                of={pairZoom}
                label="View scale"
                format={(value) => `${value.toFixed(1)}×`}
              />
              <button type="button" class="btn btn-outline" onClick={() => resetPair.run()}>
                Reset pair
              </button>
            </div>
            <div class="svg-pair-layout">
              <div>
                <div class="svg-lab-figure-heading">
                  <span>05 / circle + circle</span>
                  <span>lengths in mm</span>
                </div>
                <PairDrawing pair={pair()} active={active()} hover={setHovered} select={select} />
                <p class="svg-lab-caption">
                  Drag B around A. Keep tangent to orbit at contact, then change either radius. This
                  changes position, not rolling motion.
                </p>
              </div>
              <aside class="svg-pair-reading">
                <p class="svg-lab-eyebrow">External gap</p>
                <output class="svg-pair-gap-value" data-pair-gap={pair().gap}>
                  {mm(pair().gap)}
                </output>
                <p class="svg-pair-status" data-pair-status={pair().relation}>
                  {relationName[pair().relation]}
                </p>
                <p>{pairDescription(pair())}</p>
                <dl>
                  <div>
                    <dt>Centre distance d</dt>
                    <dd>{mm(pair().distance)}</dd>
                  </div>
                  <div>
                    <dt>rA + rB</dt>
                    <dd>{mm(pair().sum)}</dd>
                  </div>
                  <div>
                    <dt>Bearing</dt>
                    <dd>{pair().angle}°</dd>
                  </div>
                </dl>
                <Show
                  when={pair().normal !== null}
                  fallback={
                    <p class="svg-pair-degenerate">
                      Drag B away from A to choose a normal before holding tangency.
                    </p>
                  }
                >
                  <p class="svg-lab-caption">
                    Centre-line normal A → B:
                    <br />
                    <RichTeX>
                      <Term
                        id="pair-normal"
                        active={active() === "normal"}
                        onHover={hover("normal")}
                        onClick={() => select("normal")}
                      >
                        {"\\mathbf n"}
                      </Term>
                    </RichTeX>
                    {" = ("}
                    {pair().normal?.x.toFixed(3)}, {pair().normal?.y.toFixed(3)}
                    {")"}
                  </p>
                  <Show when={pair().contactPoint !== null}>
                    <p class="svg-lab-caption">
                      <RichTeX>
                        <Term
                          id="pair-tangent"
                          active={active() === "tangent"}
                          onHover={hover("tangent")}
                          onClick={() => select("tangent")}
                        >
                          {"\\mathbf t"}
                        </Term>
                        {" \\perp \\mathbf n"}
                      </RichTeX>{" "}
                      at the contact point.
                    </p>
                  </Show>
                </Show>
              </aside>
            </div>
            <div class="svg-pair-equation">
              <RichTeX display>
                <Term
                  id="pair-gap"
                  active={active() === "gap"}
                  onHover={hover("gap")}
                  onClick={() => select("gap")}
                >
                  g
                </Term>
                {" = "}
                <Term
                  id="pair-distance"
                  active={active() === "distance"}
                  onHover={hover("distance")}
                  onClick={() => select("distance")}
                >
                  d
                </Term>
                {" - ("}
                <Term
                  id="pair-radius-a"
                  control={radiusA}
                  format={mm}
                  active={active() === "a"}
                  onHover={hover("a")}
                  onClick={() => select("a")}
                >
                  {"r_A"}
                </Term>
                {" + "}
                <Term
                  id="pair-radius-b"
                  control={radiusB}
                  format={mm}
                  active={active() === "b"}
                  onHover={hover("b")}
                  onClick={() => select("b")}
                >
                  {"r_B"}
                </Term>
                {")"}
              </RichTeX>
              <p class="svg-pair-substitution">
                {pair().distance.toFixed(1)} − ({pair().radiusA.toFixed(1)} +{" "}
                {pair().radiusB.toFixed(1)}) = <strong>{mm(pair().gap)}</strong>
              </p>
              <p class="svg-lab-caption">
                Scrub either radius in the equation or drawing. A negative external gap alone does
                not distinguish intersection from containment.
              </p>
            </div>
          </>
        )}
      </CellView>
      <p class="svg-pair-scope">
        Relations use polar distance and radii in 0.5 mm steps; bearing moves in whole degrees.
        Contact and intersection points are numerical Cartesian constructions. At coincident
        centres, the normal is undefined. This experiment has no forces or rolling dynamics.
      </p>
    </section>
  );
}
