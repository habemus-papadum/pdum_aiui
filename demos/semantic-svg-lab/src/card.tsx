import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { describeCircuit, initialCircuit } from "./model/circuit";
import { CircuitScene } from "./ui/CircuitScene";
import "./styles.css";

export const card: DemoCard = {
  blurb:
    "A movable lens reveals terminals. Edit one occurrence and follow its identity across views.",
  Preview: () => (
    <svg
      class="svg-lab-card"
      viewBox="0 0 1000 520"
      role="img"
      aria-label="Two circuit blocks, one with its resistor selected"
    >
      <title>Semantic SVG circuit lens experiment</title>
      <CircuitScene
        stages={describeCircuit(initialCircuit()).stages}
        selected="a/R1/value"
        detail="lens"
      />
    </svg>
  ),
};
