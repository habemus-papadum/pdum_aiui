import { elementWidth } from "@habemus-papadum/aiui-viz";
import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { type Point, RESISTANCE, resolveFeature } from "../model/circuit";
import type { AppGraph } from "../model/graph";
import type { Evidence, FrozenView, Proposal } from "../model/markup";
import {
  cameraFor,
  cameraTransform,
  clamp,
  contains,
  lensBox,
  lensCamera,
  project,
  unproject,
  viewportBounds,
} from "../model/projection";
import {
  history,
  lensPosition,
  lensVisible,
  magnification,
  navigate,
  pan,
  selected,
  selectFeature,
  setResistance,
  zoom,
} from "../model/store";
import { CircuitScene } from "./CircuitScene";
import { MarkupOverlay } from "./MarkupOverlay";
import { snapshotSvg } from "./markup-images";

type CircuitReadout = NonNullable<ReturnType<AppGraph["circuit"]["latest"]>>;

/** The editor pins target and revision when typing begins; stale drafts are never silently applied. */
function LensEditor(props: { target: string }) {
  const [draft, setDraft] = createSignal<{ key: string; revision: number; value: string }>();
  const [error, setError] = createSignal("");
  const currentValue = () =>
    history.get().current.stages[resolveFeature(props.target).ref.occurrence].resistance / 1000;
  const editing = () => (draft()?.key === props.target ? draft() : undefined);
  return (
    <form
      class="svg-lab-lens-form"
      aria-label="Edit resistor through lens"
      onSubmit={(event) => {
        event.preventDefault();
        const candidate = editing();
        try {
          setResistance.run({
            key: props.target,
            ohms: Number(candidate?.value ?? currentValue()) * 1000,
            expectedRevision: candidate?.revision ?? history.get().current.revision,
          });
          setDraft(undefined);
          setError("");
        } catch (cause) {
          setError(String((cause as Error).message));
        }
      }}
    >
      <label>
        <span>
          {props.target.startsWith("a/") ? "A" : "B"} · R1 <span class="svg-lab-unit">kΩ</span>
        </span>
        <input
          aria-label="Resistance in kiloohms"
          type="number"
          min={RESISTANCE.min / 1000}
          max={RESISTANCE.max / 1000}
          step={RESISTANCE.step / 1000}
          value={editing()?.value ?? currentValue()}
          onInput={(event) => {
            const previous = editing();
            setDraft({
              key: props.target,
              revision: previous?.revision ?? history.get().current.revision,
              value: event.currentTarget.value,
            });
            setError("");
          }}
        />
      </label>
      <button class="btn" type="submit">
        Apply
      </button>
      <Show when={error()}>
        <p class="svg-lab-editor-error" role="alert">
          {error()}{" "}
          <button
            type="button"
            onClick={() => {
              setDraft(undefined);
              setError("");
            }}
          >
            Reload value
          </button>
        </p>
      </Show>
    </form>
  );
}

export function CircuitBoard(props: {
  circuit: CircuitReadout;
  hideEditor?: boolean;
  evidence?: Evidence;
  proposal?: Proposal;
  registerSnapshot?: (read: () => FrozenView) => () => void;
}) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  let releaseSnapshot: (() => void) | undefined;
  let measureFrame = 0;
  onCleanup(() => {
    cancelAnimationFrame(measureFrame);
    releaseSnapshot?.();
  });
  const attach = (element: HTMLDivElement) => {
    measureFrame = requestAnimationFrame(() => {
      // Warm the shared size cache after layout, outside a reactive calculation.
      elementWidth(element)();
      setHost(element);
      releaseSnapshot = props.registerSnapshot?.(() => {
        if (!svg) throw new Error("The drawing is not ready yet.");
        return snapshotSvg(svg, {
          size: size(),
          camera: camera(),
          lens: lensVisible.get() ? { camera: lens(), box: box() } : null,
          target: selected.get(),
          circuit: history.get().current,
        });
      });
    });
  };
  let svg: SVGSVGElement | undefined;
  let overview: SVGSVGElement | undefined;
  const clipId = `terminal-lens-${createUniqueId()}`;
  const hostWidth = elementWidth(host);
  const size = createMemo(() => ({ width: Math.max(280, hostWidth() || 850), height: 520 }));
  const camera = createMemo(() => cameraFor(size(), zoom.get(), pan.get()));
  const box = createMemo(() => lensBox(size(), lensPosition.get()));
  const lens = createMemo(() => lensCamera(camera(), box(), magnification.get()));
  const bounds = createMemo(() => viewportBounds(camera(), size()));
  const editableTarget = () => {
    const feature = resolveFeature(selected.get());
    const point = project(feature.point, lens());
    const visibleBox = { ...box(), height: box().height - 64 };
    return !props.hideEditor &&
      lensVisible.get() &&
      feature.ref.part === "R1" &&
      feature.ref.feature === "value" &&
      contains(visibleBox, point)
      ? feature.key
      : undefined;
  };
  const pick = (view: string) => (key: string) => selectFeature.run({ key, view });
  function local(event: { clientX: number; clientY: number }, element = svg): Point {
    const matrix = element?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }
  let drag:
    | { pointer: number; kind: "lens" | "camera"; start: Point; initial: Point; scale: number }
    | undefined;
  function start(event: PointerEvent, kind: "lens" | "camera") {
    if (event.button !== 0 || !svg) return;
    event.preventDefault();
    event.stopPropagation();
    const b = box();
    drag = {
      pointer: event.pointerId,
      kind,
      start: local(event),
      initial: kind === "lens" ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : pan.get(),
      scale: camera().scale,
    };
    svg.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const p = local(event);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    navigate.run(
      drag.kind === "lens"
        ? {
            target: "lens",
            x: clamp((drag.initial.x + dx) / size().width, 0, 1),
            y: clamp((drag.initial.y + dy) / size().height, 0, 1),
          }
        : {
            target: "camera",
            x: drag.initial.x - dx / drag.scale,
            y: drag.initial.y - dy / drag.scale,
          },
    );
  }
  function end(event: PointerEvent, cancel = false) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const previous = drag;
    drag = undefined;
    if (cancel)
      navigate.run(
        previous.kind === "camera"
          ? { target: "camera", ...previous.initial }
          : {
              target: "lens",
              x: previous.initial.x / size().width,
              y: previous.initial.y / size().height,
            },
      );
    if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  }
  function focus(point: Point) {
    const c = cameraFor(size(), zoom.get(), { x: 0, y: 0 });
    const center = unproject({ x: size().width / 2, y: size().height / 2 }, c);
    navigate.run({ target: "camera", x: point.x - center.x, y: point.y - center.y });
  }
  let overviewPointer: number | undefined;
  const navigateOverview = (event: PointerEvent) => {
    const point = local(event, overview);
    focus({ x: clamp(point.x, 0, 1000), y: clamp(point.y, 0, 520) });
  };
  return (
    <div class="svg-lab-workbench">
      <div>
        <div class="svg-lab-figure-heading">
          <span>01 / circuit + terminal lens</span>
          <span>revision {props.circuit.revision}</span>
        </div>
        <div class="svg-lab-board" ref={attach}>
          <svg
            ref={svg}
            viewBox={`0 0 ${size().width} ${size().height}`}
            aria-label="Interactive circuit with movable terminal lens"
            onPointerDown={(event) => {
              if (!(event.target as Element).closest("[data-feature], [data-lens-handle]"))
                start(event, "camera");
            }}
            onPointerMove={move}
            onPointerUp={(event) => end(event)}
            onPointerCancel={(event) => end(event, true)}
            onLostPointerCapture={() => {
              drag = undefined;
            }}
          >
            <title>
              Two instances of one circuit block. Drag the background to pan. Drag the lens header
              to reveal terminals.
            </title>
            <defs>
              <clipPath id={clipId}>
                <rect x={box().x} y={box().y} width={box().width} height={box().height} />
              </clipPath>
            </defs>
            <g transform={cameraTransform(camera())}>
              <CircuitScene
                stages={props.circuit.stages}
                selected={selected.get()}
                detail="main"
                onSelect={pick("main")}
              />
              <MarkupOverlay evidence={props.evidence} proposal={props.proposal} />
            </g>
            <Show when={lensVisible.get()}>
              <g clip-path={`url(#${clipId})`}>
                <rect
                  class="svg-lab-lens-ground"
                  x={box().x}
                  y={box().y}
                  width={box().width}
                  height={box().height}
                />
                <g transform={cameraTransform(lens())}>
                  <CircuitScene
                    stages={props.circuit.stages}
                    selected={selected.get()}
                    detail="lens"
                    onSelect={pick("lens")}
                  />
                  <MarkupOverlay evidence={props.evidence} proposal={props.proposal} />
                </g>
              </g>
              <rect
                class="svg-lab-lens-frame"
                x={box().x}
                y={box().y}
                width={box().width}
                height={box().height}
              />
              {/* biome-ignore lint/a11y/useSemanticElements: SVG has no native button; this group supports focus, Enter-independent arrow navigation, and pointer dragging. */}
              <g
                data-lens-handle="true"
                class="svg-lab-lens-handle"
                role="button"
                tabindex="0"
                aria-label="Move terminal lens with arrow keys or drag"
                onPointerDown={(event) => start(event, "lens")}
                onKeyDown={(event) => {
                  const dx = event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0;
                  const dy = event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0;
                  if (!dx && !dy) return;
                  event.preventDefault();
                  navigate.run({
                    target: "lens",
                    x: clamp((box().x + box().width / 2 + dx) / size().width, 0, 1),
                    y: clamp((box().y + box().height / 2 + dy) / size().height, 0, 1),
                  });
                }}
              >
                <rect x={box().x} y={box().y - 28} width={box().width} height="28" />
                <text x={box().x + 12} y={box().y - 10}>
                  ⠿ TERMINALS{" "}
                  <tspan x={box().x + box().width - 46}>{magnification.get().toFixed(1)}×</tspan>
                </text>
              </g>
            </Show>
          </svg>
          <Show when={editableTarget()} keyed>
            {(target) => (
              <div
                class="svg-lab-lens-editor"
                style={{
                  left: `${box().x + 8}px`,
                  top: `${box().y + box().height - 64}px`,
                  width: `${box().width - 16}px`,
                }}
              >
                <LensEditor target={target} />
              </div>
            )}
          </Show>
        </div>
        <p class="svg-lab-caption">
          {props.hideEditor
            ? "Drag the lens or the background to explore. The guided change keeps its captured target."
            : "Drag the lens by its header. Select a resistor value inside it to edit. Drag the background to pan."}
        </p>
      </div>
      <aside class="svg-lab-sidebar">
        <div class="svg-lab-figure-heading">
          <span>02 / navigation overview</span>
        </div>
        <svg
          class="svg-lab-overview"
          ref={overview}
          viewBox="0 0 1000 520"
          aria-label="Circuit overview. Click or drag to navigate."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            overviewPointer = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            navigateOverview(event);
          }}
          onPointerMove={(event) => {
            if (event.pointerId === overviewPointer) navigateOverview(event);
          }}
          onPointerUp={(event) => {
            overviewPointer = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            overviewPointer = undefined;
          }}
        >
          <title>Overview of both circuit occurrences with the main viewport outlined.</title>
          <path class="svg-lab-wire" d="M400 260 H600" />
          <g
            data-overview-occurrence="a"
            class={selected.get().startsWith("a/") ? "is-selected" : ""}
          >
            <rect class="svg-lab-overview-stage" x="90" y="70" width="310" height="360" />
            <text x="245" y="195" text-anchor="middle">
              A
            </text>
            <text x="245" y="275" text-anchor="middle">
              {props.circuit.stages[0].resistance / 1000} kΩ
            </text>
          </g>
          <g
            data-overview-occurrence="b"
            class={selected.get().startsWith("b/") ? "is-selected" : ""}
          >
            <rect class="svg-lab-overview-stage" x="600" y="70" width="310" height="360" />
            <text x="755" y="195" text-anchor="middle">
              B
            </text>
            <text x="755" y="275" text-anchor="middle">
              {props.circuit.stages[1].resistance / 1000} kΩ
            </text>
          </g>
          <rect
            class="svg-lab-viewport"
            x={bounds().x}
            y={bounds().y}
            width={bounds().width}
            height={bounds().height}
          />
        </svg>
        <div class="svg-lab-focus-buttons">
          <button
            class="btn btn-outline"
            type="button"
            onClick={() => {
              pick("overview")("a/R1/value");
              focus({ x: 270, y: 250 });
              navigate.run({ target: "lens", x: 0.5, y: 0.5 });
            }}
          >
            Focus A
          </button>
          <button
            class="btn btn-outline"
            type="button"
            onClick={() => {
              pick("overview")("b/R1/value");
              focus({ x: 780, y: 250 });
              navigate.run({ target: "lens", x: 0.5, y: 0.5 });
            }}
          >
            Focus B
          </button>
        </div>
        <p class="svg-lab-caption">
          The outline is the main viewport. Selection is shown at its containing block.
        </p>
        <div class="svg-lab-inspector">
          <span class="svg-lab-eyebrow">Selected feature</span>
          <h3>{resolveFeature(selected.get()).label}</h3>
          <code data-semantic-selection={selected.get()}>{selected.get()}</code>
          <p>
            {resolveFeature(selected.get()).net
              ? `Connected to ${resolveFeature(selected.get()).net}.`
              : "One occurrence of the shared common-source definition."}
          </p>
          <Show when={resolveFeature(selected.get()).hidden}>
            <p>
              The bulk terminal is hidden in the main view. Its connection to ground still exists.
            </p>
          </Show>
          <Show when={selected.get().includes("/R1/")}>
            <p>
              {props.hideEditor
                ? "The guided workflow edits the captured resistor, even if you select another feature here."
                : "Select the value inside the lens to change this occurrence’s resistance."}
            </p>
          </Show>
        </div>
      </aside>
    </div>
  );
}
