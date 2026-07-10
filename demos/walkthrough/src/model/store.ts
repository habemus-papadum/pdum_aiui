/**
 * store.ts — the durable roots and the **control surface** (playbook layer 2,
 * state side): the independent variables of the experiment. Names, definition
 * sites, and the descriptions below are compiler-injected — the doc comment IS
 * the registry description an agent reads in `report`.
 *
 * Curation note: `seed` is a durableSignal, not a control — it is derived
 * state the `re-seed` action bumps, not a knob a person drags. The surface is
 * chosen, not automatic.
 */
import { control, durable, durableSignal } from "@habemus-papadum/aiui-viz";
import { INITIAL_CONDITIONS, type InitialCondition } from "../lib/diffusion";

/** Diffusion coefficient κ — how fast heat spreads down the rod. */
export const kappa = control({ value: 0.1, min: 0.01, max: 1, step: 0.01 });

/** Grid resolution: number of points along the rod. */
export const points = control({ value: 256, min: 64, max: 1024, step: 64 });

/** Total simulated time T — how far the evolution runs. */
export const simTime = control({ value: 0.02, min: 0.005, max: 0.05, step: 0.005, unit: " s" });

/** Initial temperature profile. */
export const ic = control<InitialCondition>({ value: "gaussian", options: INITIAL_CONDITIONS });

/** Snapshots captured across the run (the space-time picture's rows). */
export const FRAME_COUNT = 96;

/** RNG seed for the "noise" profile; the re-seed action bumps it. */
export const seed = durableSignal("seed", 1);

/** The evolution worker - durable: created once, adopted across hot edits. */
export const diffusionWorker = (): Worker =>
  durable(
    "diffusion-worker",
    () => new Worker(new URL("./diffusion.worker.ts", import.meta.url), { type: "module" }),
  );
