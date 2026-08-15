/**
 * store.ts — the talk's OWN control surface, under its own scope.
 *
 * Deliberately NOT demo-gears' store: importing another app's durable
 * identity is the cross-pollination scopes exist to prevent. The talk reuses
 * the gears demo's PURE geometry only (gear.ts, via its barrel) and declares
 * the few knobs the slides move — so a control adjusted inside one slide's
 * Lens detail (the pressure angle on the "involute" slide) visibly persists
 * in a later slide's figure: the "folded into the computational graph" claim,
 * made checkable.
 *
 * The deck's own navigation control (`gear-talk/slide`) is declared by
 * createDeckModel in ../deck.ts — same scope, same agent surface.
 */
import { control, scope } from "@habemus-papadum/aiui-viz";

/** The talk's instance scope: ONE slug qualifying every declaration —
 * controls ("gear-talk/pressureAngle"), cells, actions, the graph key, and
 * the agent toolkit (window.__gear_talk). */
export const talkScope = scope("gear-talk");

/** Pressure angle φ: the flank inclination of every involute in the talk.
 *  Move it in the "line of action" lens and watch every later figure agree. */
export const pressureAngle = control({
  scope: talkScope,
  value: 20,
  min: 12,
  max: 28,
  step: 0.5,
  unit: "°",
});

/** Addendum height, in modules (tooth tip above the pitch circle). */
export const addendum = control({ scope: talkScope, value: 1, min: 0.6, max: 1.4, step: 0.05 });

/** Dedendum depth, in modules (tooth root below the pitch circle). */
export const dedendum = control({ scope: talkScope, value: 1.25, min: 0.8, max: 1.6, step: 0.05 });

/** Teeth on the driving gear of the design-slide pair. */
export const teethA = control({ scope: talkScope, value: 13, min: 6, max: 40, step: 1 });

/** Teeth on the driven gear of the design-slide pair. */
export const teethB = control({ scope: talkScope, value: 21, min: 6, max: 40, step: 1 });

/** Whether the mesh slide's animation is running. */
export const running = control({ scope: talkScope, value: true });

/** Drive speed of the mesh slide's gear A, in rpm (negative reverses). */
export const rpm = control({
  scope: talkScope,
  value: 6,
  min: -30,
  max: 30,
  step: 0.5,
  unit: "rpm",
});
