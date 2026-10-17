/**
 * store.ts — the catalog page's durable roots and its control surface. The
 * page has no subject of its own: its "model" is one damped wave, declared
 * here so the real aiui-viz pieces can be exhibited live over real controls —
 * the same slider, scrub pill, equation knob, diagram knob and `set` tool all
 * move the same `frequency`. Everything below survives a hot edit; the cells
 * (graph.ts) and the components (ui/) are rebuilt over it.
 *
 * `control({ value, … })` needs no name or description — the aiui compiler
 * injects the name from the binding and lifts the description from the doc
 * comment above it.
 */
import { action, control, scope } from "@habemus-papadum/aiui-viz";
import { SHAPES, type Shape } from "./wave";

/** The page's instance scope — qualifies every declaration so it can share a
 * document with the other notebooks in the gallery. */
export const appScope = scope("catalog");

/** The page's title, as a SitePage declares it and the page specimen shows it. */
export const PAGE_TITLE = "catalog — what aiui-viz provides";

// ── the control surface: one wave ────────────────────────────────────────────

/** Frequency f of the specimen wave, in hertz. The slider, the scrub pill, the
 * equation's knob and the diagram's knob all move this one control. */
export const frequency = control({
  scope: appScope,
  value: 1.5,
  min: 0.5,
  max: 4,
  step: 0.1,
  unit: " Hz",
});

/** Damping ζ of the specimen wave: how fast the envelope e^{-ζt} decays. */
export const damping = control({
  scope: appScope,
  value: 0.6,
  min: 0,
  max: 2,
  step: 0.05,
  unit: "/s",
});

/** The waveform under the envelope: a sine, a square or a triangle. */
export const shape = control<Shape>({ scope: appScope, value: "sine", options: SHAPES });

/** Draw the decay envelope ±e^{-ζt} over the wave in the plot. */
export const showEnvelope = control({ scope: appScope, value: true });

/** Make the `summary` cell fail — exhibits the error state and its Retry. */
export const breakSummary = control({ scope: appScope, value: false });

/** Jump the wave to a random frequency and damping. */
export const randomize = action({
  scope: appScope,
  name: "randomize",
  run: () => ({
    // Writes validate through each control's own meta; return what was written.
    frequency: frequency.set(Math.round((0.5 + Math.random() * 3.5) * 10) / 10),
    damping: damping.set(Math.round(Math.random() * 40) / 20),
  }),
});

// ── bookkeeping the specimens read (not part of the surface) ─────────────────

/** How many times a host has activated this page (mounted it, or returned to
 * it): the durable that proves pause-not-destroy. */
export const activations = appScope.durableSignal<number>("activations", 0);

/** How many times a host has parked this page. */
export const deactivations = appScope.durableSignal<number>("deactivations", 0);

/** When the refresh-aware dropdown was opened, newest last (the last five). */
export const refreshes = appScope.durableSignal<readonly string[]>("refreshes", []);

/** The node selected in the diagram specimen, by its Mermaid id. */
export const selectedNode = appScope.durableSignal<string | undefined>("selected", undefined);

/** Select a node, or toggle it off. */
export function selectNode(id: string | undefined): void {
  selectedNode.set(id === selectedNode.get() ? undefined : id);
}

/** Strokes drawn on the ink specimen this session. */
export const strokes = appScope.durableSignal<number>("strokes", 0);
