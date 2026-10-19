import { createMemo, For, Show } from "solid-js";
import {
  type DCCircuit,
  type DCResult,
  PARTS,
  type PartId,
  PINS,
  type PinId,
  pinRef,
  type Wire,
  wireRef,
} from "../model/dc-circuit";
import { type DCLayout, pinPosition, wireLabelPosition, wirePath } from "../model/dc-layout";
export const volts = (v: number | null) =>
  v === null ? "unresolved" : `${Math.abs(v) < 0.0005 ? "0.000" : v.toFixed(3)} V`;
export const amps = (a: number | null) =>
  a === null ? "unresolved" : `${Math.abs(a) < 0.0000005 ? "0.000" : (a * 1000).toFixed(3)} mA`;
export const ohms = (value: number) => `${(value / 1000).toFixed(2)} kΩ`;
export function voltageColor(v: number | null, supply: number) {
  return v === null
    ? "var(--dc-muted)"
    : `color-mix(in srgb, var(--dc-high) ${Math.min(100, Math.max(0, (100 * v) / supply))}%, var(--dc-low))`;
}
function member(model: DCCircuit, id: string) {
  const found = model.wires.find((w) => w.id === id);
  if (!found) throw new Error("Wire no longer exists.");
  return found;
}
export function DCScene(props: {
  result: DCResult;
  layout: DCLayout;
  active?: string;
  anchor?: PinId;
  lens?: boolean;
  names?: boolean;
  from?: PinId | null;
  ghost?: Pick<Wire, "a" | "b">;
  select?: (ref: string) => void;
  hover?: (ref: string | null) => void;
  drag?: (event: PointerEvent, part: PartId) => void;
  keyboard?: (event: KeyboardEvent, part: PartId) => void;
}) {
  const result = createMemo(() => props.result),
    model = createMemo(() => result().model),
    layout = createMemo(() => props.layout);
  const net = createMemo(() => (props.anchor ? result().netOf[props.anchor] : -1));
  const p = (pin: PinId) => pinPosition(layout(), pin);
  const select = (ref: string) => props.select?.(ref);
  const key = (event: KeyboardEvent, ref: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(ref);
    }
  };
  return (
    <>
      <For each={model().wires.map((w) => w.id)}>
        {(id) => {
          const wire = createMemo(() => member(model(), id));
          const location = createMemo(() => wireLabelPosition(layout(), wire()), {
            equals: (a, b) => a.x === b.x && a.y === b.y,
          });
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: readonly captures omit both the role and focus; live projections expose keyboard input.
            <g
              class="svg-dc-wire"
              data-ref={wireRef(id)}
              data-active={props.active === wireRef(id) ? "true" : undefined}
              data-net-active={net() === result().netOf[wire().a] ? "true" : undefined}
              style={{
                color: props.lens
                  ? voltageColor(result().voltages[wire().a], model().supply)
                  : undefined,
              }}
              data-unresolved={
                props.lens && result().voltages[wire().a] === null ? "true" : undefined
              }
              role={props.select ? "button" : undefined}
              tabindex={props.select ? 0 : undefined}
              aria-label={`Wire ${id.toUpperCase()}: ${wire().a} to ${wire().b}`}
              onClick={() => select(wireRef(id))}
              onKeyDown={(e) => key(e, wireRef(id))}
              onPointerEnter={() => props.hover?.(wireRef(id))}
              onPointerLeave={() => props.hover?.(null)}
            >
              <path class="svg-dc-wire-line" d={wirePath(layout(), wire())} />
              <path class="svg-dc-wire-hit" d={wirePath(layout(), wire())} />
              <text class="svg-dc-wire-label" x={location().x} y={location().y}>
                {id.toUpperCase()}
              </text>
            </g>
          );
        }}
      </For>
      <Show when={props.ghost}>
        {(ghost) => <path class="svg-dc-proposed" d={wirePath(layout(), ghost())} />}
      </Show>
      <For each={PARTS}>
        {(part) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: readonly captures omit both the role and focus; live projections expose keyboard input.
          <g
            class="svg-dc-part"
            data-ref={`part/${part}`}
            data-active={props.active === `part/${part}` ? "true" : undefined}
            transform={`translate(${layout()[part].x} ${layout()[part].y})`}
            role={props.select ? "button" : undefined}
            tabindex={props.select ? 0 : undefined}
            aria-label={`Component ${part}`}
            onClick={() => select(`part/${part}`)}
            onPointerDown={(e) => props.drag?.(e, part)}
            onKeyDown={(e) => {
              key(e, `part/${part}`);
              props.keyboard?.(e, part);
            }}
          >
            <rect class="svg-dc-part-hit" x="-28" y="-35" width="120" height="70" />
            <Show
              when={part === "V1"}
              fallback={
                <>
                  <path class="svg-dc-lead" d="M0 -50 V-27 M0 27 V50" />
                  <rect class="svg-dc-resistor" x="-12" y="-27" width="24" height="54" />
                  <text x="27" y="-4">
                    {part}
                  </text>
                  <text class="svg-dc-value" x="27" y="18">
                    {ohms(model().resistance[part as "R1" | "R2" | "RL"])}
                  </text>
                </>
              }
            >
              <path class="svg-dc-lead" d="M0 -60 V-28 M0 28 V60" />
              <circle class="svg-dc-source" r="28" />
              <path class="svg-dc-source-sign" d="M-7 -10 H7 M0 -17 V-3 M-7 12 H7" />
              <text x="40" y="-4">
                V1
              </text>
              <text class="svg-dc-value" x="40" y="18">
                {model().supply} V
              </text>
            </Show>
          </g>
        )}
      </For>
      <For each={PINS}>
        {(pin) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: readonly captures omit both the role and focus; live projections expose keyboard input.
          <g
            class="svg-dc-pin"
            data-ref={pinRef(pin)}
            data-active={props.active === pinRef(pin) || props.from === pin ? "true" : undefined}
            data-net-active={net() === result().netOf[pin] ? "true" : undefined}
            transform={`translate(${p(pin).x} ${p(pin).y})`}
            style={{
              color: props.lens ? voltageColor(result().voltages[pin], model().supply) : undefined,
            }}
            role={props.select ? "button" : undefined}
            tabindex={props.select ? 0 : undefined}
            aria-label={`Terminal ${pin}`}
            onClick={() => select(pinRef(pin))}
            onKeyDown={(e) => key(e, pinRef(pin))}
          >
            <circle class="svg-dc-pin-hit" r="19" />
            <circle class="svg-dc-pin-dot" r="5" />
            <Show when={props.names}>
              <text class="svg-dc-pin-label" x="11" y="-8">
                {pin}
              </text>
            </Show>
          </g>
        )}
      </For>
      <g class="svg-dc-ground" transform={`translate(${p("V1/n").x} ${p("V1/n").y})`}>
        <path d="M0 0 h-35 v18 M-49 18 h28 M-44 24 h18 M-39 30 h8" />
        <text x="-38" y="48" text-anchor="middle">
          0 V
        </text>
      </g>
      <g class="svg-dc-probe" transform={`translate(${p("R2/a").x} ${p("R2/a").y})`}>
        <path d="M-8 0 h-25" />
        <text x="-38" y="-4" text-anchor="end">
          OUT
        </text>
        <text x="-38" y="15" text-anchor="end">
          {volts(result().output)}
        </text>
      </g>
      <text class="svg-dc-scene-caption" x="22" y="443">
        ONLY EXPLICIT WIRES CONNECT · CURRENT THROUGH RESISTORS: a → b
      </text>
    </>
  );
}
