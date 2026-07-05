/**
 * regime-data.ts — the reference catalog of Gray-Scott regimes.
 *
 * The (F, k) plane was mapped by Pearson (1993, "Complex Patterns in a Simple
 * System"); the friendly names follow the common WebGL parameterization
 * (Du = 1.0, Dv = 0.5, dt = 1, 9-point Laplacian) popularized by Karl Sims.
 * Values are starting points — every regime has structure worth exploring a
 * few thousandths of F or k away.
 *
 * In the app this data arrives through a *simulated slow download* (see
 * graph.ts) so the fetch-with-progress/cancel/retry pattern has something
 * real to load. The data itself ships with the app; only the latency is fake.
 */

export interface Regime {
  id: string;
  name: string;
  /** Pearson's greek class, where one applies. */
  pearson?: string;
  F: number;
  k: number;
  character: string;
}

export const REGIME_CATALOG: Regime[] = [
  {
    id: "solitons",
    name: "Solitons",
    pearson: "λ",
    F: 0.03,
    k: 0.062,
    character: "Stable spots that space themselves out and sit still.",
  },
  {
    id: "mitosis",
    name: "Mitosis",
    pearson: "λ/μ",
    F: 0.0367,
    k: 0.0649,
    character: "Spots grow and divide like cells until the field is tiled.",
  },
  {
    id: "coral",
    name: "Coral growth",
    pearson: "κ",
    F: 0.0545,
    k: 0.062,
    character: "Fingers branch and anastomose into a coral-like labyrinth.",
  },
  {
    id: "worms",
    name: "Worms",
    pearson: "μ",
    F: 0.058,
    k: 0.065,
    character: "Short worms crawl, join, and settle into loose mazes.",
  },
  {
    id: "maze",
    name: "Maze stripes",
    pearson: "θ",
    F: 0.029,
    k: 0.057,
    character: "Stripes fill space as a connected labyrinth.",
  },
  {
    id: "holes",
    name: "Negative spots",
    pearson: "ι",
    F: 0.039,
    k: 0.058,
    character: "Holes (negatons) punched in a connected sheet of V.",
  },
  {
    id: "chaos",
    name: "Spatiotemporal chaos",
    pearson: "β",
    F: 0.026,
    k: 0.051,
    character: "Perpetually churning; patterns form and tear apart.",
  },
  {
    id: "waves",
    name: "Traveling waves",
    pearson: "α",
    F: 0.014,
    k: 0.045,
    character: "Wave fronts sweep and annihilate; nothing is stable.",
  },
  {
    id: "uskate",
    name: "U-skate world",
    F: 0.062,
    k: 0.061,
    character: "The famous glider regime — spots that swim.",
  },
  {
    id: "pulses",
    name: "Pulsating solitons",
    F: 0.025,
    k: 0.06,
    character: "Spots that breathe — expand, contract, never settle.",
  },
  {
    id: "moving",
    name: "Moving spots",
    F: 0.014,
    k: 0.054,
    character: "Self-propelled spots that wander and collide.",
  },
  {
    id: "dissolve",
    name: "Dissolution",
    F: 0.01,
    k: 0.047,
    character: "Pattern collapses; V starves and the field goes blank.",
  },
];
