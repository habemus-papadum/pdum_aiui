import { describe, expect, it } from "vitest";
import {
  type Contact,
  type ContactPolicyOptions,
  type ContactState,
  createContactState,
  transitionContact,
  withinPenCooldown,
} from "./policy";

const finger = (id: number, x = 0, y = 0): Contact => ({
  id,
  kind: "touch",
  x,
  y,
  width: 1,
  height: 1,
});
const pen = (id: number): Contact => ({ ...finger(id), kind: "pen" });
const down = (state: ContactState, contact: Contact, options?: ContactPolicyOptions) =>
  transitionContact(state, { type: "down", contact, now: 0 }, options);

describe("contact transitions", () => {
  it("cancels provisional finger ink and assigns the pen without mutating prior state", () => {
    const empty = createContactState();
    const first = down(empty, finger(1));
    const next = down(first.state, pen(2));
    expect(empty.contacts.size).toBe(0);
    expect(first.state.contacts.size).toBe(1);
    expect(first.state.drawing).toBe(1);
    expect(next.state.drawing).toBe(2);
    expect(next.effects).toEqual([
      { type: "pen-enabled" },
      { type: "cancel", pointerId: 1 },
      { type: "begin", pointerId: 2 },
    ]);
  });

  it("does not acquire a contact when explicit pen input is disabled", () => {
    const state = createContactState();
    const transition = transitionContact(
      state,
      { type: "down", contact: pen(1), now: 0 },
      { penMode: "explicit" },
    );
    expect(transition.state).toBe(state);
    expect(transition.effects).toEqual([]);
    expect(transition.decision.reason).toBe("pen-disabled");
  });

  it("suppresses navigation after a pen lift at timestamp zero", () => {
    let state = down(createContactState(), pen(1)).state;
    state = transitionContact(state, { type: "up", contact: pen(1), now: 0 }).state;
    state = down(state, finger(2, 10)).state;
    state = down(state, finger(3, 20)).state;
    const held = transitionContact(
      state,
      { type: "move", contact: finger(3, 30), now: 499 },
      { navCooldownMs: 500 },
    );
    expect(held.effects).toEqual([]);
    expect(held.decision.reason).toBe("pen-cooldown");
    const ready = transitionContact(
      held.state,
      { type: "move", contact: finger(3, 40), now: 500 },
      { navCooldownMs: 500 },
    );
    expect(ready.effects).toEqual([
      { type: "navigation", from: { x: 20, y: 0 }, to: { x: 25, y: 0 }, scale: 1.5, rotation: 0 },
    ]);
  });

  it("rebases suppressed navigation movement before it is re-enabled", () => {
    let state = down(createContactState(), finger(1, 10)).state;
    state = down(state, finger(2, 20)).state;
    const held = transitionContact(
      state,
      { type: "move", contact: finger(2, 50), now: 0 },
      { navigation: false },
    );
    expect(held.effects).toEqual([]);
    const next = transitionContact(held.state, { type: "move", contact: finger(2, 60), now: 0 });
    expect(next.effects).toEqual([
      { type: "navigation", from: { x: 30, y: 0 }, to: { x: 35, y: 0 }, scale: 1.25, rotation: 0 },
    ]);
  });

  it("uses the shortest angle across the -π/π boundary", () => {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const point = (degrees: number) =>
      finger(2, 100 * Math.cos(radians(degrees)), 100 * Math.sin(radians(degrees)));
    let state = down(createContactState(), finger(1)).state;
    state = down(state, point(179)).state;
    const forward = transitionContact(state, { type: "move", contact: point(-179), now: 0 });
    const effect = forward.effects[0];
    expect(effect?.type).toBe("navigation");
    if (effect?.type !== "navigation") throw new Error("Missing navigation");
    expect(effect.rotation).toBeCloseTo(radians(2));
    expect(effect.scale).toBeCloseTo(1);
    const backward = transitionContact(forward.state, {
      type: "move",
      contact: point(179),
      now: 0,
    });
    const reverse = backward.effects[0];
    if (reverse?.type !== "navigation") throw new Error("Missing navigation");
    expect(reverse.rotation).toBeCloseTo(radians(-2));
  });

  it("keeps the same finger pair while extra fingers and palms arrive and move", () => {
    let state = down(createContactState(), finger(1, 10)).state;
    state = down(state, finger(2, 20)).state;
    state = down(state, finger(3, 1000)).state;
    const third = transitionContact(state, { type: "move", contact: finger(3, -1000), now: 0 });
    expect(third.effects).toEqual([]);
    expect(third.state.pinch?.ids).toEqual([1, 2]);
    const palm = { ...finger(4, 500), width: 90 };
    state = down(third.state, palm, { palmContactPx: 60 }).state;
    const palmMove = transitionContact(
      state,
      { type: "move", contact: { ...palm, x: 100 }, now: 0 },
      { palmContactPx: 60 },
    );
    expect(palmMove.effects).toEqual([]);
    expect(palmMove.decision.reason).toBe("palm");
    const moved = transitionContact(palmMove.state, {
      type: "move",
      contact: finger(2, 30),
      now: 0,
    });
    expect(moved.effects).toEqual([
      { type: "navigation", from: { x: 15, y: 0 }, to: { x: 20, y: 0 }, scale: 2, rotation: 0 },
    ]);
    // Replacing a lifted member establishes a fresh baseline without a transform jump.
    const lifted = transitionContact(moved.state, { type: "up", contact: finger(1, 10), now: 0 });
    expect(lifted.effects).toEqual([]);
    expect(lifted.state.pinch?.ids).toEqual([2, 3]);
    const after = transitionContact(lifted.state, {
      type: "move",
      contact: finger(3, -1010),
      now: 0,
    });
    const effect = after.effects[0];
    if (effect?.type !== "navigation") throw new Error("Missing navigation");
    expect(effect.to.x - effect.from.x).toBe(-5);
    expect(effect.rotation).toBe(0);
  });

  it("keeps an explicitly size-rejected contact excluded when its area shrinks", () => {
    const options = { palmContactPx: 60 };
    let state = down(createContactState(), { ...finger(1), width: 90 }, options).state;
    state = down(state, finger(2, 20), options).state;
    state = transitionContact(
      state,
      { type: "move", contact: finger(1, 10), now: 0 },
      options,
    ).state;
    expect(state.pinch).toBeNull();
    expect(state.contacts.get(1)?.width).toBe(90);
    expect(state.drawing).toBe(2);
    const growing = transitionContact(
      state,
      { type: "move", contact: { ...finger(2, 30), height: 90 }, now: 0 },
      options,
    );
    expect(growing.effects).toEqual([{ type: "cancel", pointerId: 2 }]);
    expect(growing.state.pinch).toBeNull();
  });

  it("requires touches present during pen writing to lift before they can navigate", () => {
    let state = down(createContactState(), finger(1, 10)).state;
    state = down(state, pen(9)).state;
    state = down(state, finger(2, 20)).state;
    expect([...state.navigationBlocked]).toEqual([1, 2]);
    state = transitionContact(state, { type: "up", contact: pen(9), now: 0 }).state;
    const held = transitionContact(state, { type: "move", contact: finger(2, 30), now: 1000 });
    expect(held.effects).toEqual([]);
    expect(held.state.pinch).toBeNull();
    expect(held.decision.reason).toBe("held-during-pen");
    state = transitionContact(held.state, { type: "up", contact: finger(1), now: 1000 }).state;
    state = transitionContact(state, { type: "up", contact: finger(2), now: 1000 }).state;
    state = down(state, finger(1, 10)).state;
    state = down(state, finger(2, 20)).state;
    const fresh = transitionContact(state, { type: "move", contact: finger(2, 30), now: 1000 });
    expect(fresh.decision.disposition).toBe("navigation");
  });

  it("allows fresh fingers immediately after a pen lift by default", () => {
    let state = down(createContactState(), pen(9)).state;
    state = transitionContact(state, { type: "up", contact: pen(9), now: 0 }).state;
    state = down(state, finger(1, 10)).state;
    state = down(state, finger(2, 20)).state;
    expect(
      transitionContact(state, { type: "move", contact: finger(2, 30), now: 0 }).decision
        .disposition,
    ).toBe("navigation");
  });

  it.each([
    12, 72, 120,
  ])("accepts fresh %i px contacts in Pencil mode without inferring palms from size", (size) => {
    const contact = (id: number, x: number) => ({ ...finger(id, x), width: size, height: size });
    let state = createContactState({ penEnabled: true });
    state = down(state, contact(1, 20)).state;
    expect(state.drawing).toBeNull();
    state = down(state, contact(2, 60)).state;
    const moved = transitionContact(state, { type: "move", contact: contact(2, 80), now: 0 });
    expect(moved.decision.disposition).toBe("navigation");
    expect(moved.effects).toEqual([
      { type: "navigation", from: { x: 40, y: 0 }, to: { x: 50, y: 0 }, scale: 1.5, rotation: 0 },
    ]);
  });

  it("does not emit zero scales or undefined angles when fingers coincide", () => {
    let state = down(createContactState(), finger(1, 10)).state;
    state = down(state, finger(2, 20)).state;
    const joined = transitionContact(state, { type: "move", contact: finger(2, 10), now: 0 });
    expect(joined.effects).toEqual([
      { type: "navigation", from: { x: 15, y: 0 }, to: { x: 10, y: 0 }, scale: 1, rotation: 0 },
    ]);
    const apart = transitionContact(joined.state, { type: "move", contact: finger(2, 20), now: 0 });
    expect(apart.effects).toEqual([
      { type: "navigation", from: { x: 10, y: 0 }, to: { x: 15, y: 0 }, scale: 1, rotation: 0 },
    ]);
  });

  it("retains pen mode when resetting ownership and cancels once", () => {
    const state = down(createContactState(), pen(1)).state;
    const reset = transitionContact(state, { type: "reset", now: 10, enabled: false });
    expect(reset.effects).toEqual([{ type: "cancel", pointerId: 1 }]);
    expect(reset.state).toMatchObject({
      drawing: null,
      enabled: false,
      penEnabled: true,
      lastPenUp: 10,
    });
    expect(reset.state.contacts.size).toBe(0);
    expect(transitionContact(reset.state, { type: "reset", now: 20 }).effects).toEqual([]);
    expect(down(reset.state, pen(2)).decision.reason).toBe("disabled");
  });

  it("allows no pen-history state independently of timestamp zero", () => {
    expect(withinPenCooldown(false, null, 0, 500)).toBe(false);
    expect(withinPenCooldown(false, 0, 0, 500)).toBe(true);
    expect(withinPenCooldown(false, 0, 500, 500)).toBe(false);
    expect(withinPenCooldown(true, null, 900, 0)).toBe(true);
  });
});
