/**
 * store.ts — Layer 2 (durable side): the control surface of the gear studio.
 *
 * Each `control()` is one user-movable parameter. The aiui compiler injects the
 * name from the binding and lifts these doc comments as the agent-facing
 * description, so every knob is settable from a slider, the keyboard, AND the
 * derived `set` agent tool — validated once, here. Editing this file forces a
 * full reload; the cell graph (graph.ts) and components (ui/) are the parts
 * meant to be edited live.
 */
import { control, scope } from "@habemus-papadum/aiui-viz";

/** The demo's instance scope: ONE slug qualifying every declaration —
 * controls ("gears/teethA"), durables, cells, actions, the graph key, and
 * the agent toolkit (window.__gears). New declarations MUST thread it (see
 * aiui-viz scope.ts; user guide, "Composing bigger apps"). */
export const gearsScope = scope("gears");

// --- the two gears ----------------------------------------------------------

/** Teeth on the driving gear (gear A). */
export const teethA = control({ scope: gearsScope, value: 12, min: 6, max: 40, step: 1 });

/** Teeth on the driven gear (gear B). */
export const teethB = control({ scope: gearsScope, value: 20, min: 6, max: 40, step: 1 });

/** Module m (mm): the tooth-size unit. Pitch diameter = m × teeth. */
export const module = control({
  scope: gearsScope,
  value: 8,
  min: 2,
  max: 16,
  step: 0.5,
  unit: "mm",
});

/** Pressure angle φ: the flank inclination. 20° is the modern standard; smaller
 *  angles give slimmer teeth, larger angles stubbier, stronger ones. */
export const pressureAngle = control({
  scope: gearsScope,
  value: 20,
  min: 12,
  max: 28,
  step: 0.5,
  unit: "°",
});

/** Addendum height, in modules: how far the tooth tip rises above the pitch circle. */
export const addendum = control({ scope: gearsScope, value: 1, min: 0.6, max: 1.4, step: 0.05 });

/** Dedendum depth, in modules: how far the tooth root drops below the pitch circle. */
export const dedendum = control({ scope: gearsScope, value: 1.25, min: 0.8, max: 1.6, step: 0.05 });

// --- the animation / drive --------------------------------------------------

/** Drive angle: rotation of gear A in degrees. Scrub it to step the mesh by
 *  hand; the animation writes it back while running. Gear B follows by the
 *  gear ratio, so the teeth stay meshed at every angle. */
export const driveAngle = control({
  scope: gearsScope,
  value: 0,
  min: 0,
  max: 360,
  step: 0.5,
  unit: "°",
});

/** Whether the mesh is animating. */
export const running = control({ scope: gearsScope, value: false });

/** Drive speed of gear A, in rpm (negative reverses). Low values give the
 *  slow-motion view of the contact point crossing the line of action. */
export const rpm = control({
  scope: gearsScope,
  value: 4,
  min: -30,
  max: 30,
  step: 0.5,
  unit: "rpm",
});

// --- display toggles --------------------------------------------------------

/** Show the construction overlay: pitch circles, base circles, line of centres,
 *  and the line of action (the fixed line the contact point rides). */
export const showConstruction = control({ scope: gearsScope, value: true });

/** Show the live contact point(s) and their common normal (the contact force
 *  direction) sliding along the line of action. */
export const showContact = control({ scope: gearsScope, value: true });

// --- non-surface durable state ---------------------------------------------
// (nothing curated as a knob, but reserved here per the durable/disposable split)

/** Which section the tooth studio is inspecting: gear A's tooth or gear B's. */
export const studioGear = gearsScope.durableSignal<"A" | "B">("studioGear", "A");
