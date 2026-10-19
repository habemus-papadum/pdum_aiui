import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import {
  OCCURRENCES,
  type Occurrence,
  PLACEMENTS,
  resistanceLabel,
  STAGE,
  STAGE_SIZE,
} from "../model/circuit";

interface SceneProps {
  stages: readonly { occurrence: Occurrence; resistance: number }[];
  selected?: string;
  detail: "main" | "lens";
  onSelect?: (key: string) => void;
}
function Feature(props: {
  id: string;
  label: string;
  selected?: string;
  onSelect?: (key: string) => void;
  children: JSX.Element;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: SVG features receive a button role when interactive; card previews are inert.
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-pressed is supplied only with the dynamic button role.
    <g
      class={`svg-lab-feature${props.selected === props.id ? " is-selected" : ""}`}
      data-feature={props.id}
      role={props.onSelect ? "button" : undefined}
      tabindex={props.onSelect ? 0 : undefined}
      aria-label={props.label}
      aria-pressed={props.onSelect ? (props.selected === props.id ? "true" : "false") : undefined}
      onClick={(event) => {
        if (!props.onSelect) return;
        event.stopPropagation();
        props.onSelect?.(props.id);
      }}
      onKeyDown={(event) => {
        if (!props.onSelect) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          props.onSelect?.(props.id);
        }
      }}
    >
      <title>{props.label}</title>
      {props.children}
    </g>
  );
}

/** Same source features in two presentations; the lens reveals the existing bulk terminal. */
export function CircuitScene(props: SceneProps) {
  return (
    <g class="svg-lab-circuit" data-projection={props.detail}>
      <path class="svg-lab-wire" d="M400 250 H500 V300 H702" />
      <text class="svg-lab-net" x="490" y="239" text-anchor="middle">
        interstage
      </text>
      <For each={OCCURRENCES}>
        {(occurrence) => {
          const origin = PLACEMENTS[occurrence];
          const value = () =>
            props.stages.find((stage) => stage.occurrence === occurrence)?.resistance ?? 0;
          const key = (part: string, feature: string) => `${occurrence}/${part}/${feature}`;
          const selectedPart = (part: string) =>
            props.selected?.startsWith(`${occurrence}/${part}/`);
          return (
            <g transform={`translate(${origin.x} ${origin.y})`} data-occurrence={occurrence}>
              <rect
                class={`svg-lab-stage${props.selected?.startsWith(`${occurrence}/`) ? " is-selected" : ""}`}
                width={STAGE_SIZE.width}
                height={STAGE_SIZE.height}
              />
              <text class="svg-lab-stage-title" x="20" y="28">
                {occurrence.toUpperCase()}{" "}
                <tspan class="svg-lab-stage-subtitle">common-source</tspan>
              </text>
              <path
                class="svg-lab-wire"
                d="M150 44 V70 M150 130 V207 M150 180 H310 M0 230 H122 M150 250 V310 M132 310 H168 M138 317 H162 M144 324 H156"
              />
              <text class="svg-lab-net" x="162" y="54">
                VDD
              </text>
              <text class="svg-lab-net" x="12" y="219">
                in
              </text>
              <text class="svg-lab-net" x="272" y="169">
                out
              </text>
              <circle class="svg-lab-junction" cx="150" cy="180" r="3" />
              <Feature
                id={key("R1", "body")}
                label={`${occurrence.toUpperCase()} R1 resistor`}
                selected={props.selected}
                onSelect={props.onSelect}
              >
                <rect class="svg-lab-hit" x="128" y="65" width="44" height="70" />
                <rect
                  class={`svg-lab-symbol${selectedPart("R1") ? " is-related" : ""}`}
                  x="139"
                  y="70"
                  width="22"
                  height="60"
                />
                <text class="svg-lab-symbol-name" x="118" y="105" text-anchor="end">
                  R1
                </text>
              </Feature>
              <Feature
                id={key("R1", "value")}
                label={`${occurrence.toUpperCase()} R1 value ${resistanceLabel(value())}`}
                selected={props.selected}
                onSelect={props.onSelect}
              >
                <rect class="svg-lab-value-box" x="174" y="88" width="116" height="32" />
                <text class="svg-lab-value" x="182" y="110">
                  {resistanceLabel(value())}
                </text>
              </Feature>
              <Feature
                id={key("M1", "body")}
                label={`${occurrence.toUpperCase()} M1 transistor`}
                selected={props.selected}
                onSelect={props.onSelect}
              >
                <rect class="svg-lab-hit" x="114" y="203" width="48" height="54" />
                <path
                  class={`svg-lab-symbol${selectedPart("M1") ? " is-related" : ""}`}
                  d="M122 209 V251 M135 209 V251 M135 211 H150 V190 M135 249 H150 V270 M135 230 H148"
                />
                <text class="svg-lab-symbol-name" x="173" y="215">
                  M1
                </text>
              </Feature>
              <Show when={props.detail === "lens"}>
                <path class="svg-lab-hidden-wire" d="M148 230 H202 V290 H150" />
                <For each={STAGE.pins}>
                  {(pin) => (
                    <Feature
                      id={key(pin.part, pin.feature)}
                      label={`${occurrence.toUpperCase()} ${pin.part} ${pin.feature} terminal`}
                      selected={props.selected}
                      onSelect={props.onSelect}
                    >
                      <circle class="svg-lab-hit" cx={pin.x} cy={pin.y} r="13" />
                      <circle class="svg-lab-pin" cx={pin.x} cy={pin.y} r="4" />
                      <text
                        class="svg-lab-pin-label"
                        x={
                          pin.x +
                          (pin.part === "R1" || pin.feature === "gate" || pin.feature === "drain"
                            ? -8
                            : 9)
                        }
                        y={pin.feature === "drain" ? pin.y + 4 : pin.y - 7}
                        text-anchor={
                          pin.part === "R1" || pin.feature === "gate" || pin.feature === "drain"
                            ? "end"
                            : "start"
                        }
                      >
                        {pin.feature === "upper"
                          ? "1"
                          : pin.feature === "lower"
                            ? "2"
                            : pin.feature}
                      </text>
                    </Feature>
                  )}
                </For>
              </Show>
              <text class="svg-lab-definition" x="20" y="344">
                {props.detail === "lens"
                  ? "bulk → ground · explicit connection"
                  : "common-source / two occurrences"}
              </text>
            </g>
          );
        }}
      </For>
    </g>
  );
}
