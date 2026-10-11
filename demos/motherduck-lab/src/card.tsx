/** A lightweight illustration of cloud rows becoming a local sample; no engine or credentials. */
import { chart, TOKENS } from "@habemus-papadum/aiui-design";
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { For } from "solid-js";

function Preview() {
  return (
    <svg viewBox="0 0 240 125" role="img" aria-label="Cloud data flowing into a local histogram">
      <rect width="240" height="125" fill={TOKENS.plate} />
      <g fill="none" stroke={chart().blue} stroke-width="1.5">
        <ellipse cx="54" cy="35" rx="28" ry="9" />
        <path d="M26 35v46c0 12 56 12 56 0V35 M26 58c0 12 56 12 56 0" />
        <path d="M96 62h33m-7-6 7 6-7 6" />
      </g>
      <For each={[16, 31, 48, 39, 23, 12]}>
        {(h, i) => <rect x={145 + i() * 11} y={88 - h} width="8" height={h} fill={chart().green} />}
      </For>
    </svg>
  );
}

export const card: DemoCard = {
  blurb:
    "Explore your MotherDuck tables with linked histograms. Sample cloud data into this browser and query both together. Bring a read-scaling token.",
  Preview,
};
