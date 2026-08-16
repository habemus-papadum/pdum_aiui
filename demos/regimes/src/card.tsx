/**
 * card.tsx — the landing card: a live miniature of the §3 decomposition.
 *
 * Self-contained and cheap on purpose (a landing mounts every app's preview at
 * once): it draws three PRECOMPUTED regimes of the stacked loss bar — computed
 * once at mount from the pure model only, no store, no graph, no cells — and
 * gently cycles between them.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import { createSignal, onCleanup } from "solid-js";
import { decompose } from "./model/regress";

const COLORS = { floor: "#3a4152", approximation: "#9b6fdb", estimation: "#4a86dd" };

interface Preset {
  label: string;
  parts: [number, number, number]; // floor, approximation, estimation
}

function presets(): Preset[] {
  const mk = (label: string, degree: number, n: number): Preset => {
    const d = decompose({ degree, n, sigma: 0.5, trials: 10, seed: 7 });
    return { label, parts: [d.floor, d.approximation, d.estimation] };
  };
  return [
    mk("approximation-limited", 2, 300),
    mk("balanced", 8, 120),
    mk("estimation-limited", 12, 40),
  ];
}

function Preview() {
  const all = presets();
  const [idx, setIdx] = createSignal(0);
  const timer = setInterval(() => setIdx((i) => (i + 1) % all.length), 2200);
  onCleanup(() => clearInterval(timer));

  const bar = (p: Preset) => {
    const total = p.parts.reduce((a, b) => a + b, 0);
    const keys = ["floor", "approximation", "estimation"] as const;
    return (
      <div style={{ display: "flex", height: "22px", "border-radius": "5px", overflow: "hidden" }}>
        {p.parts.map((v, i) => (
          <div
            style={{
              width: `${(100 * v) / total}%`,
              background: COLORS[keys[i]],
              transition: "width 600ms ease",
            }}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        "flex-direction": "column",
        "justify-content": "center",
        gap: "10px",
        padding: "18px",
        background: "#0b0d13",
        "box-sizing": "border-box",
      }}
    >
      {bar(all[idx()])}
      <div style={{ font: "11px ui-monospace, monospace", color: "#9aa0aa" }}>
        {all[idx()].label}
      </div>
      <div style={{ display: "flex", gap: "10px", font: "10px ui-monospace, monospace" }}>
        <span style={{ color: COLORS.floor }}>■ floor</span>
        <span style={{ color: COLORS.approximation }}>■ approximation</span>
        <span style={{ color: COLORS.estimation }}>■ estimation</span>
      </div>
    </div>
  );
}

export const card: DemoCard = {
  blurb:
    "Which error owns your loss? Pointwise vs distributional games, the four-term decomposition, ensembling, spectral bias, and the horizon — each measured live on a tiny honest simulator.",
  Preview,
};
