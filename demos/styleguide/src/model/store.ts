/**
 * store.ts — the styleguide's durable roots: a tiny control surface that
 * exists so the sheet can exhibit the REAL aiui-viz widgets (slider, toggle,
 * select, scrub pill) and the real cell states, with real class names. The
 * numbers describe a Gray–Scott plate, because the specimen is a notebook
 * section; nothing here computes one.
 *
 * `control({ value, … })` needs no name or description — the aiui compiler
 * injects the name from the binding and lifts the description from the doc
 * comment above it. Controls are durable across hot edits.
 */
import { control, scope } from "@habemus-papadum/aiui-viz";

/** The sheet's instance scope — qualifies every declaration so it can share a
 * document with the other notebooks in the gallery. */
export const appScope = scope("styleguide");

/** Feed rate f of the Gray–Scott system (the specimen's slider). */
export const feed = control({
  scope: appScope,
  value: 0.037,
  min: 0,
  max: 0.1,
  step: 0.001,
  unit: "/s",
});

/** Kill rate k of the Gray–Scott system (the specimen's second slider). */
export const kill = control({
  scope: appScope,
  value: 0.062,
  min: 0,
  max: 0.1,
  step: 0.001,
  unit: "/s",
});

/** Whether the nullcline overlay is drawn (the specimen's toggle). */
export const nullcline = control({ scope: appScope, value: true });

/** The preset the plate was seeded from (the specimen's select). */
export const preset = control({
  scope: appScope,
  value: "mitosis",
  options: ["mitosis", "coral", "worms"] as const,
});

/** Make the catalog cell fail — exhibits the error state and its Retry. */
export const breakCatalog = control({ scope: appScope, value: false });
