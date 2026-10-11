import { chart } from "@habemus-papadum/aiui-design";
import type { DemoCard } from "@habemus-papadum/aiui-viz";
export const card: DemoCard = {
  blurb: "Capture a screen, isolate an element, and inspect the live stream.",
  Preview: () => (
    <svg
      viewBox="0 0 320 180"
      role="img"
      aria-label="A selected region within a screen"
      style={{ width: "100%", height: "100%", background: "var(--plate)" }}
    >
      <rect x="30" y="25" width="260" height="130" fill="none" stroke="var(--plate-ink)" />
      <rect
        x="65"
        y="50"
        width="160"
        height="85"
        fill="none"
        stroke="var(--plate-ink)"
        stroke-dasharray="5 4"
      />
      <path
        d="M65 93 Q85 55 105 93 T145 93 T185 93 T225 93"
        fill="none"
        stroke={chart().blue}
        stroke-width="2"
      />
    </svg>
  ),
};
