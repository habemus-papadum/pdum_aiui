import { createMemo, For, Show } from "solid-js";
import {
  forceFor,
  forceKind,
  JOINT_IDS,
  type JointId,
  jointById,
  jointRef,
  memberById,
  memberName,
  memberRef,
  type Point,
  type Structure,
  type StructureResult,
  supportRef,
} from "../model/structure";

export const STRUCTURE_SIZE = { width: 640, height: 420 };
export function structureView(model: Structure) {
  const xs = model.joints.map((j) => j.x),
    ys = model.joints.map((j) => j.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const scale = Math.min(460 / Math.max(4, maxX - minX), 230 / Math.max(3, maxY - minY));
  return { scale, x: 320 - ((minX + maxX) / 2) * scale, y: 225 + ((minY + maxY) / 2) * scale };
}
export type StructureView = ReturnType<typeof structureView>;
export const projectJoint = (p: Point, view: StructureView) => ({
  x: view.x + p.x * view.scale,
  y: view.y - p.y * view.scale,
});
export function ForceArrow(props: { x: number; y: number; dx: number; dy: number }) {
  const length = () => Math.hypot(props.dx, props.dy);
  const head = () => Math.min(8, length() / 2);
  return (
    <g
      transform={`translate(${props.x} ${props.y}) rotate(${(Math.atan2(props.dy, props.dx) * 180) / Math.PI})`}
    >
      <line x1="0" y1="0" x2={length()} y2="0" />
      <path
        d={`M${length()} 0 l${-head()} ${-head() / 2} v${head()} Z`}
        fill="currentColor"
        stroke="none"
      />
    </g>
  );
}
interface SceneProps {
  result: StructureResult;
  view: StructureView;
  active?: string;
  lens?: boolean;
  motion?: boolean;
  ghost?: { a: JointId; b: JointId };
  select?: (ref: string) => void;
  hover?: (ref: string | null) => void;
  drag?: (event: PointerEvent, joint: JointId) => void;
  keyboard?: (event: KeyboardEvent, joint: JointId) => void;
  connectFrom?: JointId | null;
}
function activate(event: KeyboardEvent, fn: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fn();
  }
}
/** Each projection carries the same opaque object ref; pixels are never the identity. */
export function StructureScene(props: SceneProps) {
  const result = createMemo(() => props.result);
  const model = createMemo(() => result().model);
  const view = createMemo(() => props.view);
  const p = (id: JointId) => projectJoint(jointById(model(), id), view());
  const choose = (ref: string) => props.select?.(ref);
  const ghostPoint = (id: JointId) => {
    const j = jointById(model(), id),
      m = result().motion?.[id];
    return projectJoint({ x: j.x + (m?.x ?? 0) * 0.35, y: j.y + (m?.y ?? 0) * 0.35 }, view());
  };
  return (
    <>
      <g class="svg-structure-grid">
        <For each={[-1, 0, 1, 2, 3, 4, 5, 6, 7]}>
          {(x) => (
            <line
              x1={view().x + x * view().scale}
              x2={view().x + x * view().scale}
              y1="40"
              y2="370"
            />
          )}
        </For>
        <For each={[0, 1, 2, 3, 4]}>
          {(y) => (
            <line
              x1="35"
              x2="605"
              y1={view().y - y * view().scale}
              y2={view().y - y * view().scale}
            />
          )}
        </For>
      </g>
      <Show when={props.motion && !!result().motion}>
        <g class="svg-structure-motion" aria-label="One possible infinitesimal motion, exaggerated">
          <For each={model().members.map((m) => m.id)}>
            {(id) => {
              const m = createMemo(() => memberById(model(), id));
              return (
                <line
                  x1={ghostPoint(m().a).x}
                  y1={ghostPoint(m().a).y}
                  x2={ghostPoint(m().b).x}
                  y2={ghostPoint(m().b).y}
                />
              );
            }}
          </For>
          <For each={JOINT_IDS}>
            {(id) => (
              <ForceArrow
                x={p(id).x}
                y={p(id).y}
                dx={ghostPoint(id).x - p(id).x}
                dy={ghostPoint(id).y - p(id).y}
              />
            )}
          </For>
        </g>
      </Show>
      <For each={model().members.map((m) => m.id)}>
        {(id) => {
          const m = createMemo(() => memberById(model(), id));
          const ref = memberRef(id);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: role and focus are present only in the interactive projection.
            <g
              class="svg-structure-member"
              data-ref={ref}
              data-active={props.active === ref ? "true" : undefined}
              data-force={props.lens ? forceKind(forceFor(result(), m())) : "plain"}
              role={props.select ? "button" : undefined}
              tabindex={props.select ? 0 : undefined}
              aria-label={`Member ${memberName(m())}`}
              onClick={() => choose(ref)}
              onKeyDown={(e) => activate(e, () => choose(ref))}
              onPointerEnter={() => props.hover?.(ref)}
              onPointerLeave={() => props.hover?.(null)}
            >
              <line
                class="svg-structure-member-line"
                x1={p(m().a).x}
                y1={p(m().a).y}
                x2={p(m().b).x}
                y2={p(m().b).y}
              />
              <line
                class="svg-structure-hit"
                x1={p(m().a).x}
                y1={p(m().a).y}
                x2={p(m().b).x}
                y2={p(m().b).y}
              />
              <text
                class="svg-structure-member-label"
                x={(p(m().a).x + p(m().b).x) / 2 + 9}
                y={(p(m().a).y + p(m().b).y) / 2 - 10}
              >
                {memberName(m())}
              </text>
            </g>
          );
        }}
      </For>
      <Show when={props.ghost}>
        {(ghost) => (
          <line
            class="svg-structure-proposed"
            x1={p(ghost().a).x}
            y1={p(ghost().a).y}
            x2={p(ghost().b).x}
            y2={p(ghost().b).y}
          />
        )}
      </Show>
      <For each={JOINT_IDS}>
        {(id) => {
          const support = () => jointById(model(), id).support;
          return (
            <Show when={support() !== "none"}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: role and focus are present only in the interactive projection. */}
              <g
                class="svg-structure-support"
                data-ref={supportRef(id)}
                data-active={props.active === supportRef(id) ? "true" : undefined}
                transform={`translate(${p(id).x} ${p(id).y + 12}) rotate(${support() === "roller-x" ? -90 : 0})`}
                role={props.select ? "button" : undefined}
                tabindex={props.select ? 0 : undefined}
                aria-label={`Support ${id}: ${support()}`}
                onClick={() => choose(supportRef(id))}
                onKeyDown={(e) => activate(e, () => choose(supportRef(id)))}
              >
                <path d="M0 0 L-15 21 H15 Z" />
                <Show
                  when={support() !== "pin"}
                  fallback={<path d="M-22 26 H22 M-16 26 l-6 7 M-3 26 l-6 7 M10 26 l-6 7" />}
                >
                  <circle cx="-8" cy="27" r="3" />
                  <circle cx="8" cy="27" r="3" />
                  <path d="M-22 33 H22" />
                </Show>
              </g>
            </Show>
          );
        }}
      </For>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: role and focus are present only in the interactive projection. */}
      <g
        class="svg-structure-load"
        data-ref="load/main"
        data-active={props.active === "load/main" ? "true" : undefined}
        role={props.select ? "button" : undefined}
        tabindex={props.select ? 0 : undefined}
        aria-label="Applied load"
        onClick={() => choose("load/main")}
        onKeyDown={(e) => activate(e, () => choose("load/main"))}
      >
        <Show when={model().load.magnitude > 0}>
          <ForceArrow x={p(model().load.joint).x} y={p(model().load.joint).y - 82} dx={0} dy={64} />
        </Show>
        <text x={p(model().load.joint).x + 13} y={p(model().load.joint).y - 61}>
          {model().load.magnitude} N
        </text>
      </g>
      <For each={JOINT_IDS}>
        {(id) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: role and focus are present only in the interactive projection.
          <g
            class="svg-structure-joint"
            data-ref={jointRef(id)}
            data-active={
              props.active === jointRef(id) || props.connectFrom === id ? "true" : undefined
            }
            role={props.select ? "button" : undefined}
            tabindex={props.select ? 0 : undefined}
            aria-label={`Joint ${id}`}
            transform={`translate(${p(id).x} ${p(id).y})`}
            onClick={() => choose(jointRef(id))}
            onPointerDown={(e) => props.drag?.(e, id)}
            onKeyDown={(e) => {
              activate(e, () => choose(jointRef(id)));
              props.keyboard?.(e, id);
            }}
          >
            <circle class="svg-structure-joint-hit" r="22" />
            <circle class="svg-structure-pin" r="8" />
            <text
              x={id === "A" || id === "D" ? -22 : 22}
              y="7"
              text-anchor={id === "A" || id === "D" ? "end" : "start"}
            >
              {id}
            </text>
          </g>
        )}
      </For>
      <text class="svg-structure-scale" x="24" y="398">
        GRID 1 m · CROSSINGS DO NOT CONNECT
      </text>
    </>
  );
}
