import { bridgeEffect, CellView, elementWidth } from "@habemus-papadum/aiui-viz";
import { createKnobs, KnobReadout } from "@habemus-papadum/aiui-viz/site/knob";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site/rich-tex";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import {
  type ContactFeature,
  type ContactPoint,
  type ContactResult,
  type ContactViewport,
  contactFromScreen,
  contactToScreen,
  contactViewport,
} from "../model/contact";
import {
  contactScope,
  contactSelection,
  holdTangency,
  moveCircle,
  radius,
  resetContact,
  selectContact,
  tangentHeld,
  touchLine,
} from "../model/contact-store";
import { graph } from "../model/graph";

const mm = (value: number) => `${value.toFixed(1)} mm`;
const samePoint = (a: ContactPoint, b: ContactPoint) => a.x === b.x && a.y === b.y;
interface Attention {
  active: ContactFeature | null;
  hover: (feature: ContactFeature | null) => void;
  select: (feature: ContactFeature) => void;
}
function Mark(
  props: Attention & { feature: ContactFeature; label: string; children: JSX.Element },
) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: A selectable SVG group has no native button equivalent.
    <g
      class={`svg-contact-mark${props.active === props.feature ? " is-active" : ""}`}
      data-contact-feature={props.feature}
      role="button"
      tabindex="0"
      aria-label={props.label}
      aria-pressed={props.active === props.feature ? "true" : "false"}
      onPointerEnter={() => props.hover(props.feature)}
      onPointerLeave={() => props.hover(null)}
      onFocus={() => props.hover(props.feature)}
      onBlur={() => props.hover(null)}
      onClick={() => props.select(props.feature)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.select(props.feature);
        }
      }}
    >
      {props.children}
    </g>
  );
}

function ContactDrawing(props: Attention & { contact: ContactResult }) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  const width = elementWidth(host);
  const view = createMemo(() => contactViewport(Math.max(280, width() || 850)));
  const contact = createMemo(() => props.contact);
  const center = createMemo(() => contactToScreen(contact().center, view()), { equals: samePoint });
  const lowest = createMemo(() => contactToScreen(contact().lowest, view()), { equals: samePoint });
  const foot = createMemo(() => contactToScreen(contact().foot, view()), { equals: samePoint });
  const r = createMemo(() => contact().radius * view().scale);
  const heightX = createMemo(() => Math.max(24, center().x - r() - 42));
  const gapX = createMemo(() => Math.min(view().width - 28, center().x + r() + 42));
  const radiusX = createMemo(() =>
    Math.min(view().width - 126, Math.max(8, center().x + r() * 0.35)),
  );
  const uid = createUniqueId();
  const arrowId = `contact-normal-${uid}`;
  const hatchId = `contact-hatch-${uid}`;
  const knobs = createKnobs();
  let frame = 0;
  let placementFrame = 0;
  bridgeEffect(
    contact,
    () => {
      if (!placementFrame)
        placementFrame = requestAnimationFrame(() => {
          placementFrame = 0;
          knobs.place();
        });
    },
    { scope: contactScope, name: "radius-readout-position" },
  );
  let svg: SVGSVGElement | undefined;
  let radiusLabel: SVGGElement | undefined;
  let drag:
    | { pointer: number; press: ContactPoint; initial: ContactPoint; view: ContactViewport }
    | undefined;
  onCleanup(() => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(placementFrame);
    drag = undefined;
  });
  function screen(event: { clientX: number; clientY: number }): ContactPoint {
    const matrix = svg?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }
  function start(event: PointerEvent) {
    if (event.button !== 0 || drag || !svg) return;
    event.preventDefault();
    event.stopPropagation();
    props.select("circle");
    drag = {
      pointer: event.pointerId,
      press: contactFromScreen(screen(event), view()),
      initial: { ...contact().center },
      view: view(),
    };
    svg.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const point = contactFromScreen(screen(event), drag.view);
    moveCircle.run({
      x: drag.initial.x + point.x - drag.press.x,
      y: drag.initial.y + point.y - drag.press.y,
    });
  }
  function stop(cancel = false) {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    if (cancel) moveCircle.run({ ...previous.initial });
    if (svg?.hasPointerCapture(previous.pointer)) svg.releasePointerCapture(previous.pointer);
  }
  return (
    <div
      class="svg-contact-plate"
      ref={(element) => {
        frame = requestAnimationFrame(() => {
          elementWidth(element)();
          setHost(element);
          knobs.attach(element);
          if (radiusLabel) knobs.bind(radiusLabel, { control: radius, format: mm });
        });
      }}
    >
      <svg
        ref={svg}
        viewBox={`0 0 ${view().width} ${view().height}`}
        aria-label="Drag the circle toward the line; scrub its radius label"
        data-contact-state={contact().state}
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
          A circle above the line y equals zero. Drag the body to move it; drag the radius label
          sideways to resize.
        </title>
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10" fill="currentColor" />
          </marker>
          <pattern id={hatchId} width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M0 12 L12 0" class="svg-contact-hatch" />
          </pattern>
        </defs>
        <rect x="14" y={foot().y} width={view().width - 28} height="18" fill={`url(#${hatchId})`} />
        <line
          class="svg-contact-ground"
          x1="14"
          x2={view().width - 14}
          y1={foot().y}
          y2={foot().y}
        />
        <text class="svg-contact-line-label" x="22" y={foot().y + 39}>
          line · y = 0
        </text>
        <line
          class="svg-contact-guide"
          x1={heightX()}
          x2={center().x}
          y1={center().y}
          y2={center().y}
        />
        <line
          class="svg-contact-guide"
          x1={center().x}
          x2={gapX()}
          y1={lowest().y}
          y2={lowest().y}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: SVG body supports two-dimensional pointer dragging and arrow keys. */}
        <g
          class={`svg-contact-body${props.active === "circle" ? " is-active" : ""}`}
          data-contact-feature="circle"
          role="button"
          tabindex="0"
          aria-label="Move circle. Arrow keys move by half a millimetre; Shift moves by five."
          onPointerDown={start}
          onPointerEnter={() => props.hover("circle")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("circle")}
          onBlur={() => props.hover(null)}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 5 : 0.5;
            const delta =
              event.key === "ArrowLeft"
                ? { x: -step, y: 0 }
                : event.key === "ArrowRight"
                  ? { x: step, y: 0 }
                  : event.key === "ArrowUp"
                    ? { x: 0, y: step }
                    : event.key === "ArrowDown"
                      ? { x: 0, y: -step }
                      : undefined;
            if (delta) {
              event.preventDefault();
              props.select("circle");
              moveCircle.run({
                x: contact().center.x + delta.x,
                y: contact().height + delta.y,
              });
            }
          }}
        >
          <circle class="svg-contact-circle" cx={center().x} cy={center().y} r={r()} />
          <circle class="svg-contact-center" cx={center().x} cy={center().y} r="3" />
          <text x={center().x - 16} y={center().y - 10}>
            C
          </text>
        </g>
        <Mark {...props} feature="height" label="Centre height h">
          <line
            class="svg-contact-hit"
            x1={heightX()}
            x2={heightX()}
            y1={center().y}
            y2={foot().y}
          />
          <path
            d={`M${heightX()} ${center().y} V${foot().y} M${heightX() - 5} ${center().y} h10 M${heightX() - 5} ${foot().y} h10`}
          />
          <text x={heightX() - 9} y={(center().y + foot().y) / 2} text-anchor="end">
            h
          </text>
        </Mark>
        <Mark {...props} feature="gap" label="Signed gap g">
          <line
            class="svg-contact-hit"
            x1={gapX()}
            x2={gapX()}
            y1={lowest().y - 5}
            y2={foot().y + 5}
          />
          <path
            d={`M${gapX()} ${lowest().y} V${foot().y} M${gapX() - 5} ${lowest().y} h10 M${gapX() - 5} ${foot().y} h10`}
          />
          <text x={gapX() - 10} y={(lowest().y + foot().y) / 2 - 8} text-anchor="end">
            g
          </text>
        </Mark>
        <Mark {...props} feature="tangent" label="Tangent to the circle at its lowest point P">
          <line
            class="svg-contact-hit"
            x1={lowest().x - 80}
            x2={lowest().x + 80}
            y1={lowest().y}
            y2={lowest().y}
          />
          <line
            class="svg-contact-tangent"
            x1={lowest().x - 80}
            x2={lowest().x + 80}
            y1={lowest().y}
            y2={lowest().y}
          />
          <text
            class="svg-contact-small"
            x={Math.max(16, lowest().x - 88)}
            y={lowest().y - 9}
            text-anchor="end"
          >
            t
          </text>
        </Mark>
        <Mark {...props} feature="normal" label="Upward unit normal of the line">
          <line
            class="svg-contact-hit"
            x1={foot().x}
            x2={foot().x}
            y1={foot().y}
            y2={foot().y - Math.min(54, r() * 0.6)}
          />
          <line
            class="svg-contact-normal"
            x1={foot().x}
            x2={foot().x}
            y1={foot().y}
            y2={foot().y - Math.min(54, r() * 0.6)}
            marker-end={`url(#${arrowId})`}
          />
          <text x={foot().x + 10} y={foot().y - Math.min(54, r() * 0.6) + 9}>
            n
          </text>
        </Mark>
        <g class={`svg-contact-radius${props.active === "radius" ? " is-active" : ""}`}>
          <line x1={center().x} x2={center().x + r()} y1={center().y} y2={center().y} />
          <path d={`M${center().x + r()} ${center().y - 4} v8`} />
        </g>
        <g
          ref={radiusLabel}
          role="slider"
          tabindex="0"
          aria-label="Circle radius"
          aria-valuenow={contact().radius}
          aria-valuemin={radius.meta.min}
          aria-valuemax={radius.meta.max}
          onPointerEnter={() => props.hover("radius")}
          onPointerLeave={() => props.hover(null)}
          onFocus={() => props.hover("radius")}
          onBlur={() => props.hover(null)}
          onPointerDown={() => props.select("radius")}
          data-contact-feature="radius"
          data-active={props.active === "radius" ? "true" : undefined}
          class="svg-contact-radius-knob"
          transform={`translate(${radiusX()} ${center().y - 40})`}
        >
          <rect width="120" height="30" />
          <text x="8" y="21">
            r = {mm(contact().radius)}
          </text>
        </g>
        <circle class="svg-contact-point" cx={lowest().x} cy={lowest().y} r="4" />
        <Show when={contact().gap !== 0}>
          <circle class="svg-contact-foot" cx={foot().x} cy={foot().y} r="3" />
        </Show>
        <text class="svg-contact-small" x={lowest().x + 10} y={lowest().y + 20}>
          {contact().gap === 0 ? "P = Q" : "P"}
        </text>
        <Show when={contact().gap !== 0}>
          <text class="svg-contact-small" x={foot().x + 10} y={foot().y + 29}>
            Q
          </text>
        </Show>
        <text class="svg-contact-gesture-hint" x={view().width - 20} y="25" text-anchor="end">
          {contact().locked ? "TANGENCY HELD · DRAG ALONG THE LINE" : "DRAG THE CIRCLE"}
        </text>
      </svg>
      <KnobReadout of={knobs} />
    </div>
  );
}

export function ContactLab() {
  const [hovered, setHovered] = createSignal<ContactFeature | null>(null);
  const active = () => hovered() ?? contactSelection.get();
  const select = (feature: ContactFeature) => selectContact.run({ feature });
  const hover = (feature: ContactFeature) => (value: boolean) => setHovered(value ? feature : null);
  return (
    <section class="svg-contact" aria-label="Circle and line contact experiment">
      <div class="svg-contact-toolbar">
        <button
          type="button"
          class="btn"
          aria-pressed={tangentHeld.get() ? "true" : "false"}
          onClick={() => holdTangency.run({ enabled: !tangentHeld.get() })}
        >
          {tangentHeld.get() ? "Release tangency" : "Keep tangent"}
        </button>
        <button type="button" class="btn btn-outline" onClick={() => touchLine.run()}>
          Touch once
        </button>
        <button type="button" class="btn btn-outline" onClick={() => resetContact.run()}>
          Reset contact
        </button>
        <p>
          {tangentHeld.get()
            ? "Radius changes move the centre to preserve contact."
            : "Move freely, or hold tangency and slide along the line."}
        </p>
      </div>
      <CellView of={graph().contact}>
        {(contact) => (
          <>
            <div class="svg-contact-layout">
              <div>
                <div class="svg-lab-figure-heading">
                  <span>03 / circle + line</span>
                  <span>lengths in mm</span>
                </div>
                <ContactDrawing
                  contact={contact()}
                  active={active()}
                  hover={setHovered}
                  select={select}
                />
                <p class="svg-lab-caption">
                  Drag the circle. Scrub its radius label sideways. Focus either control to use the
                  arrow keys.
                </p>
              </div>
              <aside class="svg-contact-reading">
                <p class="svg-lab-eyebrow">Signed gap</p>
                <output class="svg-contact-gap" data-contact-gap={contact().gap}>
                  {mm(contact().gap)}
                </output>
                <p class="svg-contact-status" data-contact-status={contact().state}>
                  {contact().state === "separated"
                    ? "Separated"
                    : contact().state === "tangent"
                      ? "Tangent"
                      : "Crossing the line"}
                </p>
                <p>
                  {contact().state === "separated"
                    ? "P sits above the line."
                    : contact().state === "tangent"
                      ? "P and Q coincide. The circle’s tangent is the line."
                      : "The lowest point P is below the line; the signed gap is negative."}
                </p>
                <dl>
                  <div>
                    <dt>Height h</dt>
                    <dd data-contact-height={contact().height}>{mm(contact().height)}</dd>
                  </div>
                  <div>
                    <dt>Radius r</dt>
                    <dd data-contact-radius={contact().radius}>{mm(contact().radius)}</dd>
                  </div>
                </dl>
                <p class="svg-lab-caption">
                  P is the circle’s lowest point. Q is the centre’s projection onto the line. The
                  line’s normal points upward.
                </p>
              </aside>
            </div>
            <div class="svg-contact-equation">
              <div>
                <RichTeX display>
                  <Term
                    id="contact-gap"
                    active={active() === "gap"}
                    onHover={hover("gap")}
                    onClick={() => select("gap")}
                  >
                    g
                  </Term>
                  {" = "}
                  <Term
                    id="contact-height"
                    active={active() === "height"}
                    onHover={hover("height")}
                    onClick={() => select("height")}
                  >
                    h
                  </Term>
                  {" - "}
                  <Term
                    id="contact-radius"
                    control={radius}
                    format={mm}
                    active={active() === "radius"}
                    onHover={hover("radius")}
                    onClick={() => select("radius")}
                  >
                    r
                  </Term>
                </RichTeX>
                <p class="svg-contact-substitution">
                  {contact().height.toFixed(1)} − {contact().radius.toFixed(1)} ={" "}
                  <strong>{mm(contact().gap)}</strong>
                </p>
              </div>
              <p>
                Drag <strong>r</strong> in the equation: it is the same radius control as the label
                in the drawing. Select <strong>h</strong> or <strong>g</strong> to highlight its
                geometric meaning.
              </p>
            </div>
          </>
        )}
      </CellView>
      <p class="svg-contact-scope">
        This experiment uses an infinite horizontal line and a centre on its upper side. Authored
        lengths move in 0.5 mm steps; tangency is h = r, with no visual tolerance. Sliding here does
        not simulate rolling or forces.
      </p>
    </section>
  );
}
