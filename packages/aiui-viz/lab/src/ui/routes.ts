/**
 * routes.ts — the lab's pages as plain data, free of anything Vite injects, so
 * vite.config.ts can read the same list to write the published deep links.
 */
export const PAGES = [
  { id: "fidelity", name: "fidelity", desc: "the markers change nothing" },
  { id: "training", name: "training", desc: "an objective that breathes" },
  { id: "derivation", name: "derivation", desc: "every step evaluated" },
  { id: "fourier", name: "fourier", desc: "hover a term, see its wave" },
  { id: "pipeline", name: "pipeline", desc: "a diagram as a control surface" },
  { id: "anatomy", name: "anatomy", desc: "what a diagram makes addressable" },
] as const;
