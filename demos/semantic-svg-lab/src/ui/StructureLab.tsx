import { CellView, ControlToggle } from "@habemus-papadum/aiui-viz";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site/rich-tex";
import { createMemo, createSignal, For, flush, onCleanup, Show } from "solid-js";
import { graph } from "../model/graph";
import {
  type ForceTerm,
  forceFor,
  forceKind,
  hasReference,
  JOINT_IDS,
  type JointId,
  jointById,
  jointRef,
  memberById,
  memberName,
  memberRef,
  missingBrace,
  type StructureEdit,
  type StructureResult,
  SUPPORTS,
  type Support,
} from "../model/structure";
import {
  beginBrace,
  braceRequest,
  changeStructure,
  explodedJoint,
  focusedJoint,
  forceLens,
  movePreview,
  redoStructure,
  resetStructure,
  selectStructure,
  showMotion,
  structureHistory,
  structureNotice,
  structureSelection,
  undoStructure,
} from "../model/structure-store";
import { StructurePencil, statusLabel } from "./StructurePencil";
import { ForceArrow, StructureScene, type StructureView, structureView } from "./StructureScene";
import { TargetedDiagnostics } from "./TargetedDiagnostics";

const number = (n: number) => (Math.abs(n) < 0.005 ? "0" : n.toFixed(2));
const symbolText = (t: ForceTerm) => t.symbol.replace(/[{}_]/g, "");
const sameTerm = (a: ForceTerm, b: ForceTerm) =>
  a.ref === b.ref && a.symbol === b.symbol && a.x === b.x && a.y === b.y && a.value === b.value;
interface Attention {
  active: string;
  select: (ref: string) => void;
  hover: (ref: string | null) => void;
}
interface WorkbenchProps extends Attention {
  result: StructureResult;
  attempt: (fn: () => unknown) => void;
}
function commit(edit: StructureEdit, expectedRevision = structureHistory.get().current.revision) {
  return changeStructure.run({ expectedRevision, edit });
}

function StructureBoard(props: WorkbenchProps) {
  const selectedMember = createMemo(() =>
    props.result.model.members.find((m) => memberRef(m.id) === structureSelection.get()),
  );
  const [connecting, setConnecting] = createSignal(false);
  const [from, setFrom] = createSignal<JointId | null>(null);
  const [heldView, setHeldView] = createSignal<StructureView | null>(null);
  const view = createMemo(() => heldView() ?? structureView(props.result.model), {
    equals: (a, b) => a.x === b.x && a.y === b.y && a.scale === b.scale,
  });
  let svg!: SVGSVGElement;
  let drag:
    | {
        joint: JointId;
        revision: number;
        pointer: number;
        x: number;
        y: number;
        startX: number;
        startY: number;
        view: StructureView;
        moved: boolean;
      }
    | undefined;
  let suppressClick = false;
  const toView = (event: PointerEvent) => {
    const matrix = svg.getScreenCTM();
    return matrix
      ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
      : null;
  };
  function start(event: PointerEvent, joint: JointId) {
    if (connecting() || event.button !== 0 || drag) return;
    event.preventDefault();
    svg.querySelector<SVGGElement>(`[data-ref="joint/${joint}"]`)?.focus();
    const p = toView(event);
    if (!p) return;
    const model = structureHistory.get().current;
    const j = jointById(model, joint);
    drag = {
      joint,
      revision: model.revision,
      pointer: event.pointerId,
      x: j.x,
      y: j.y,
      startX: p.x,
      startY: p.y,
      view: view(),
      moved: false,
    };
    setHeldView(view());
    svg.setPointerCapture(event.pointerId);
    props.select(jointRef(joint));
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer) return;
    const p = toView(event);
    if (!p) return;
    if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 3) drag.moved = true;
    if (!drag.moved) return;
    movePreview.set({
      joint: drag.joint,
      x: drag.x + (p.x - drag.startX) / drag.view.scale,
      y: drag.y - (p.y - drag.startY) / drag.view.scale,
      expectedRevision: drag.revision,
    });
  }
  function end(cancel = false) {
    if (!drag) return;
    flush();
    const current = drag;
    drag = undefined;
    suppressClick = current.moved;
    if (!cancel && current.moved) {
      // Read the last pointer preview at the next operation boundary (commits are batched).
      props.attempt(() => {
        const preview = movePreview.get();
        if (preview)
          commit(
            { kind: "move", joint: current.joint, x: preview.x, y: preview.y },
            current.revision,
          );
      });
    }
    movePreview.set(null);
    setHeldView(null);
    if (svg.hasPointerCapture(current.pointer)) svg.releasePointerCapture(current.pointer);
  }
  onCleanup(() => {
    movePreview.set(null);
  });
  function choose(ref: string) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (connecting() && ref.startsWith("joint/")) {
      const joint = ref.split("/")[1] as JointId;
      const first = from();
      if (!first) {
        setFrom(joint);
        props.select(ref);
      } else if (first === joint) setFrom(null);
      else
        props.attempt(() => {
          commit({ kind: "add", a: first, b: joint });
          setFrom(null);
          setConnecting(false);
        });
    } else props.select(ref);
  }
  function keyboard(event: KeyboardEvent, joint: JointId) {
    if (event.key === "Escape") {
      end(true);
      setConnecting(false);
      setFrom(null);
      return;
    }
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const p = jointById(structureHistory.get().current, joint),
      step = event.shiftKey ? 0.5 : 0.1;
    props.attempt(() =>
      commit({ kind: "move", joint, x: p.x + direction[0] * step, y: p.y + direction[1] * step }),
    );
  }
  return (
    <div>
      <div class="svg-lab-figure-heading">
        <span>Construction</span>
        <span>revision {props.result.model.revision}</span>
      </div>
      <div class="svg-structure-plate">
        <svg
          ref={svg}
          class="svg-structure-board"
          viewBox="0 0 640 420"
          aria-label="Editable four-joint structure"
          onPointerMove={move}
          onPointerUp={() => end()}
          onPointerCancel={() => end(true)}
          onLostPointerCapture={() => end(true)}
        >
          <title>Drag joints or use arrow keys. Connect two joints to add a member.</title>
          <StructureScene
            result={props.result}
            view={view()}
            active={props.active}
            lens={forceLens.get()}
            motion={showMotion.get()}
            connectFrom={from()}
            select={choose}
            hover={props.hover}
            drag={start}
            keyboard={keyboard}
          />
        </svg>
      </div>
      <div class="svg-structure-drawing-tools">
        <button
          type="button"
          class="btn btn-outline"
          aria-pressed={connecting() ? "true" : "false"}
          onClick={() => {
            setConnecting(!connecting());
            setFrom(null);
          }}
        >
          {connecting() ? "Cancel connection" : "Connect joints"}
        </button>
        <Show when={selectedMember()}>
          {(member) => (
            <button
              type="button"
              class="btn btn-outline"
              onClick={() => props.attempt(() => commit({ kind: "remove", member: member().id }))}
            >
              Remove {memberName(member())}
            </button>
          )}
        </Show>
        <span role="status">
          {connecting()
            ? from()
              ? `From ${from()} → choose a second joint`
              : "Choose the first joint"
            : "Drag a joint · arrow keys move 0.1 m"}
        </span>
      </div>
      <div class="svg-structure-legend">
        <span data-force="tension">— tension</span>
        <span data-force="compression">— compression</span>
        <span data-force="zero">— zero</span>
        <span data-force="unknown">- - unresolved</span>
      </div>
      <Show when={props.result.mechanisms > 0 && props.result.motion !== null}>
        <p class="svg-lab-caption">
          Dashed ghost: one infinitesimal motion, exaggerated. It is not a simulated trajectory.
        </p>
      </Show>
    </div>
  );
}
function JointView(props: WorkbenchProps) {
  const result = createMemo(() => props.result);
  const terms = createMemo(() => result().joints[focusedJoint.get()]);
  const term = (symbol: string) => {
    const found = terms().find((t) => t.symbol === symbol);
    if (!found) throw new Error(`Unknown force ${symbol}.`);
    return found;
  };
  const total = (axis: "x" | "y") => terms().reduce((sum, t) => sum + t[axis] * (t.value ?? 0), 0);
  const lane = (t: ForceTerm) => {
    const coincident = terms().filter(
      (other) => Math.abs(other.x - t.x) < 1e-10 && Math.abs(other.y - t.y) < 1e-10,
    );
    return (
      (coincident.findIndex((other) => other.symbol === t.symbol) - (coincident.length - 1) / 2) *
      24
    );
  };
  const port = (t: ForceTerm, radius: number) => ({
    x: 180 + t.x * radius + (explodedJoint.get() ? t.y * lane(t) : 0),
    y: 150 - t.y * radius + (explodedJoint.get() ? t.x * lane(t) : 0),
  });
  const arrow = (t: ForceTerm) => {
    const magnitude = t.value === null ? 60 : Math.abs(t.value);
    // A common scale within this free body; lengths are graphical, values remain in N.
    const largest = Math.max(1, ...terms().map((t) => Math.abs(t.value ?? 60)));
    const length = magnitude < 1e-7 ? 0 : (82 * magnitude) / largest;
    const sign = (t.value ?? 1) < 0 ? -1 : 1;
    const offset = explodedJoint.get() ? 36 : 12;
    const { x, y } = port(t, offset);
    return sign > 0
      ? { x, y, dx: t.x * length, dy: -t.y * length }
      : { x: x + t.x * length, y: y - t.y * length, dx: -t.x * length, dy: t.y * length };
  };
  return (
    <div class="svg-structure-joint-panel">
      <div class="svg-lab-figure-heading">
        <span>Joint {focusedJoint.get()} · free body</span>
        <span>same objects</span>
      </div>
      <div class="svg-structure-plate">
        <svg
          class="svg-structure-free-body"
          viewBox="0 0 360 300"
          aria-label={`Free-body diagram of joint ${focusedJoint.get()}`}
        >
          <title>Member forces, support reactions and load acting on the selected joint</title>
          <line class="svg-structure-axis" x1="150" x2="210" y1="150" y2="150" />
          <line class="svg-structure-axis" x1="180" x2="180" y1="120" y2="180" />
          <For each={terms().map((t) => t.symbol)}>
            {(symbol) => {
              const t = createMemo(() => term(symbol), { equals: sameTerm });
              const ref = () => t().ref;
              const vector = createMemo(() => arrow(t()), {
                equals: (a, b) => a.x === b.x && a.y === b.y && a.dx === b.dx && a.dy === b.dy,
              });
              const label = createMemo(
                () => ({
                  x: 180 + t().x * 120 + t().y * lane(t()),
                  y: 150 - t().y * 120 + t().x * lane(t()),
                }),
                { equals: (a, b) => a.x === b.x && a.y === b.y },
              );
              return (
                // biome-ignore lint/a11y/useSemanticElements: selectable SVG force in a derived projection.
                <g
                  class="svg-structure-joint-force"
                  data-ref={ref()}
                  data-active={props.active === ref() ? "true" : undefined}
                  data-force={
                    ref().startsWith("member/") ? forceKind(t().value ?? undefined) : "load"
                  }
                  role="button"
                  tabindex="0"
                  aria-label={`${symbolText(t())} at joint ${focusedJoint.get()}`}
                  onClick={() => props.select(ref())}
                  onPointerEnter={() => props.hover(ref())}
                  onPointerLeave={() => props.hover(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      props.select(ref());
                    }
                  }}
                >
                  <Show when={explodedJoint.get()}>
                    <line
                      class="svg-structure-guide"
                      x1="180"
                      y1="150"
                      x2={port(t(), 36).x}
                      y2={port(t(), 36).y}
                    />
                    <circle
                      class="svg-structure-end"
                      cx={port(t(), 36).x}
                      cy={port(t(), 36).y}
                      r="5"
                    />
                  </Show>
                  <Show
                    when={t().value === null || Math.abs(t().value ?? 0) > 1e-7}
                    fallback={
                      <circle
                        class="svg-structure-zero"
                        cx={port(t(), 30).x}
                        cy={port(t(), 30).y}
                        r="5"
                      />
                    }
                  >
                    <ForceArrow x={vector().x} y={vector().y} dx={vector().dx} dy={vector().dy} />
                  </Show>
                  <text
                    x={label().x}
                    y={label().y}
                    text-anchor={t().x < -0.15 ? "end" : t().x > 0.15 ? "start" : "middle"}
                  >
                    {symbolText(t())}
                  </text>
                </g>
              );
            }}
          </For>
          <circle class="svg-structure-joint-core" cx="180" cy="150" r="9" />
          <text class="svg-structure-joint-name" x="180" y="155" text-anchor="middle">
            {focusedJoint.get()}
          </text>
        </svg>
      </div>
      <div class="svg-structure-force-readings">
        <For each={terms().map((t) => t.symbol)}>
          {(symbol) => {
            const t = createMemo(() => term(symbol), { equals: sameTerm });
            return (
              <button
                type="button"
                class="svg-structure-force-reading"
                data-ref={t().ref}
                aria-pressed={props.active === t().ref ? "true" : "false"}
                onClick={() => props.select(t().ref)}
              >
                <span>{symbolText(t())}</span>
                <span>
                  {t().value === null
                    ? "unresolved"
                    : `${number(Math.abs(t().value ?? 0))} N${t().ref.startsWith("member/") ? ` · ${forceKind(t().value ?? undefined)}` : ""}`}
                </span>
              </button>
            );
          }}
        </For>
      </div>
      <ControlToggle of={explodedJoint} label="Separate member ends" />
      <p class="svg-lab-caption">
        {result().status === "solved"
          ? "Arrows show forces on this joint. Positive member force means tension."
          : "Unknown member forces point outward by convention. Their values remain unresolved."}{" "}
        {explodedJoint.get()
          ? "Separated ends still belong to the same joint."
          : "Select a force to find its member in the construction."}
      </p>
      <For each={["x", "y"] as const}>
        {(axis) => (
          <div class="svg-structure-equation" data-equilibrium={axis}>
            <span class="svg-lab-eyebrow">{axis === "x" ? "Horizontal" : "Vertical"}</span>
            <RichTeX display>
              {terms()
                .filter((t) => Math.abs(t[axis]) > 1e-12)
                .map((t, i) => [
                  i ? " + " : "",
                  <Term
                    id={`structure-${focusedJoint.get()}-${axis}-${t.symbol.replace(/[^a-zA-Z0-9]/g, "")}`}
                    active={props.active === t.ref}
                    onClick={() => props.select(t.ref)}
                    onHover={(hovered) => props.hover(hovered ? t.ref : null)}
                  >
                    {`${Math.abs(t[axis] - 1) < 1e-10 ? "" : `(${number(t[axis])})\\,`}${t.symbol}`}
                  </Term>,
                ])}
              {terms().some((t) => Math.abs(t[axis]) > 1e-12) ? " = 0" : "0 = 0"}
            </RichTeX>
            <p class="svg-lab-caption">
              {result().status === "solved"
                ? `ΣF${axis} = ${number(total(axis))} N · coefficients rounded above`
                : "Equilibrium condition · unknowns are not assigned values"}
            </p>
          </div>
        )}
      </For>
    </div>
  );
}
function Inspector(props: WorkbenchProps) {
  const chosen = () => structureSelection.get();
  const member = () => props.result.model.members.find((m) => memberRef(m.id) === chosen());
  const j = () => jointById(props.result.model, focusedJoint.get());
  const [a, setA] = createSignal<JointId>("A"),
    [b, setB] = createSignal<JointId>("C");
  const [loadValue, setLoadValue] = createSignal<string | null>(null);
  return (
    <section class="svg-structure-inspector" aria-label="Structure inspector">
      <div class="svg-structure-inspector-head">
        <h3>Inspect & edit</h3>
        <span>{chosen()}</span>
      </div>
      <div class="svg-structure-inspector-grid">
        <div>
          <label>
            Inspect joint{" "}
            <select
              aria-label="Inspect joint"
              value={focusedJoint.get()}
              onChange={(e) => props.select(jointRef(e.currentTarget.value as JointId))}
            >
              <For each={JOINT_IDS}>{(id) => <option value={id}>{id}</option>}</For>
            </select>
          </label>
          <p>
            {j().id}: ({j().x.toFixed(1)}, {j().y.toFixed(1)}) m
          </p>
          <label>
            Support at {j().id}{" "}
            <select
              aria-label="Joint support"
              value={j().support}
              onChange={(e) =>
                props.attempt(() =>
                  commit({
                    kind: "support",
                    joint: j().id,
                    support: e.currentTarget.value as Support,
                  }),
                )
              }
            >
              <For each={SUPPORTS}>
                {(support) => (
                  <option value={support}>
                    {
                      {
                        none: "No support",
                        pin: "Pin · x and y",
                        "roller-y": "Roller · vertical reaction",
                        "roller-x": "Roller · horizontal reaction",
                      }[support]
                    }
                  </option>
                )}
              </For>
            </select>
          </label>
        </div>
        <div>
          <Show
            when={member()}
            fallback={
              <>
                <p>Select a member to remove or reconnect it.</p>
                <div class="svg-structure-member-list">
                  <For each={props.result.model.members.map((m) => m.id)}>
                    {(id) => (
                      <button
                        class="btn btn-outline"
                        type="button"
                        onClick={() => props.select(memberRef(id))}
                      >
                        {memberName(memberById(props.result.model, id))}
                      </button>
                    )}
                  </For>
                </div>
              </>
            }
          >
            {(currentMember) => (
              <>
                <p class="svg-structure-selected-member">
                  <strong>Member {memberName(currentMember())}</strong> ·{" "}
                  {forceFor(props.result, currentMember()) === undefined
                    ? "unresolved"
                    : `${number(Math.abs(forceFor(props.result, currentMember()) ?? 0))} N ${forceKind(forceFor(props.result, currentMember()))}`}
                </p>

                <div class="svg-structure-reconnect">
                  <label>
                    New end 1{" "}
                    <select
                      aria-label="Reconnect first endpoint"
                      value={a()}
                      onChange={(e) => setA(e.currentTarget.value as JointId)}
                    >
                      <For each={JOINT_IDS}>{(id) => <option value={id}>{id}</option>}</For>
                    </select>
                  </label>
                  <label>
                    New end 2{" "}
                    <select
                      aria-label="Reconnect second endpoint"
                      value={b()}
                      onChange={(e) => setB(e.currentTarget.value as JointId)}
                    >
                      <For each={JOINT_IDS}>{(id) => <option value={id}>{id}</option>}</For>
                    </select>
                  </label>
                  <button
                    type="button"
                    class="btn btn-outline"
                    onClick={() =>
                      props.attempt(() =>
                        commit({ kind: "reconnect", member: currentMember().id, a: a(), b: b() }),
                      )
                    }
                  >
                    Reconnect
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>
        <div>
          <label>
            Load on{" "}
            <select
              aria-label="Load joint"
              value={props.result.model.load.joint}
              onChange={(e) =>
                props.attempt(() =>
                  commit({
                    kind: "load",
                    joint: e.currentTarget.value as JointId,
                    magnitude: props.result.model.load.magnitude,
                  }),
                )
              }
            >
              <For each={JOINT_IDS}>{(id) => <option value={id}>{id}</option>}</For>
            </select>
          </label>
          <form
            class="svg-structure-load-form"
            onSubmit={(e) => {
              e.preventDefault();
              props.attempt(() => {
                const value = loadValue();
                if (value === null || value.trim() === "") return;
                commit({
                  kind: "load",
                  joint: props.result.model.load.joint,
                  magnitude: Number(value),
                });
                setLoadValue(null);
              });
            }}
          >
            <label>
              Downward force{" "}
              <input
                aria-label="Downward force"
                type="number"
                min="0"
                max="500"
                step="any"
                value={loadValue() ?? props.result.model.load.magnitude}
                onInput={(e) => setLoadValue(e.currentTarget.value)}
              />{" "}
              N
            </label>
            <button type="submit" class="btn btn-outline">
              Set load
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
export function StructureLab() {
  const [hovered, setHovered] = createSignal<string | null>(null);
  const active = () => {
    const ref = hovered();
    return ref && hasReference(structureHistory.get().current, ref)
      ? ref
      : structureSelection.get();
  };
  const attempt = (work: () => unknown) => {
    try {
      work();
      structureNotice.set("");
    } catch (error) {
      structureNotice.set(error instanceof Error ? error.message : String(error));
    }
  };
  const select = (ref: string) => attempt(() => selectStructure.run({ ref }));
  return (
    <section class="svg-structure" aria-label="Editable structure study">
      <div class="svg-structure-task">
        <strong>Break it, then repair it.</strong> Select AC and remove it. Inspect the free motion,
        then connect A to C again—or sketch a brace for review.
      </div>
      <div class="svg-lab-toolbar">
        <ControlToggle of={forceLens} label="Force lens" />
        <ControlToggle of={showMotion} label="Show free motion" />
        <button
          type="button"
          class="btn btn-outline"
          disabled={!structureHistory.get().past.length}
          onClick={() => attempt(() => undoStructure.run())}
        >
          Undo edit
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={!structureHistory.get().future.length}
          onClick={() => attempt(() => redoStructure.run())}
        >
          Redo edit
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={!!braceRequest.get() || !missingBrace(structureHistory.get().current)}
          onClick={() => attempt(() => beginBrace.run())}
        >
          Sketch a brace
        </button>
        <button
          type="button"
          class="btn btn-outline"
          onClick={() => attempt(() => resetStructure.run())}
        >
          Reset structure
        </button>
      </div>
      <Show when={!!structureNotice.get()}>
        <p role="alert" class="svg-structure-notice">
          {structureNotice.get()}
        </p>
      </Show>
      <CellView of={graph().structure}>
        {(result) => (
          <>
            <div class="svg-structure-status" data-state={result().status} role="status">
              <strong>{statusLabel(result().status)}</strong>
              <span>
                {result().model.members.length} members · {result().unknowns} unknown forces · rank{" "}
                {result().rank}/8
              </span>
            </div>
            <TargetedDiagnostics
              items={result().diagnostics}
              class="svg-structure-diagnostics"
              select={select}
              label={(ref) =>
                ref.startsWith("member/")
                  ? memberName(memberById(result().model, ref.slice("member/".length)))
                  : ref.replace("/", " ")
              }
            />
            <div class="svg-structure-layout">
              <StructureBoard
                result={result()}
                active={active()}
                select={select}
                hover={setHovered}
                attempt={attempt}
              />
              <JointView
                result={result()}
                active={active()}
                select={select}
                hover={setHovered}
                attempt={attempt}
              />
            </div>
            <Inspector
              result={result()}
              active={active()}
              select={select}
              hover={setHovered}
              attempt={attempt}
            />
          </>
        )}
      </CellView>
      <Show when={!!braceRequest.get()}>
        <StructurePencil attempt={attempt} />
      </Show>
      <section class="svg-structure-next">
        <h3>Three different ways to change the design</h3>
        <div class="svg-lab-prompts">
          <p>
            <strong>Change connectivity.</strong> Remove AC, then connect A–C or B–D. A crossing
            without a joint does not create a connection.
          </p>
          <p>
            <strong>Change the geometry.</strong> Drag D. The load and member ends follow its
            identity. Inspect D’s free body, then separate the member ends.
          </p>
          <p>
            <strong>Ask for more than equilibrium knows.</strong> Add the other diagonal while AC
            remains. Both braces are real, but their forces need a stiffness model.
          </p>
        </div>
      </section>
      <p class="svg-structure-scope">
        Ideal pin joints and weightless axial members. Supports constrain motion in both directions
        along their stated axes. Numerical equilibrium and infinitesimal rank analysis; no member
        stiffness, strength, buckling or finite motion. Session-only prototype.
      </p>
    </section>
  );
}
