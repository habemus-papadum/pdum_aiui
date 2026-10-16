/** Contact ownership and navigation decisions without browser or rendering state. */

import type { NavigationTransform } from "../geometry";
import type { PenKind } from "../telemetry";

export type FingerDrawing = "until-pen" | "always" | "never";
export type PenMode = "auto" | "explicit";

export interface ContactPolicyOptions {
  /** Auto activates pen mode on first pen contact; explicit requires setPenEnabled. */
  penMode?: PenMode;
  /** Finger drawing is provisional until a second finger or a pen arrives. */
  fingerDrawing?: FingerDrawing;
  navigation?: boolean;
  navCooldownMs?: number;
  /** Optional contact-size cutoff in CSS px. Unset: use pen activity, not contact size. */
  palmContactPx?: number;
}

export interface Contact {
  id: number;
  kind: PenKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContactState {
  readonly enabled: boolean;
  readonly penEnabled: boolean;
  readonly contacts: ReadonlyMap<number, Contact>;
  /** Contacts present during pen writing must lift before joining navigation. */
  readonly navigationBlocked: ReadonlySet<number>;
  readonly drawing: number | null;
  /** Null means no pen has lifted; timestamp zero is a valid lift. */
  readonly lastPenUp: number | null;
  readonly pinch: {
    ids: readonly [number, number];
    distance: number;
    angle: number;
    x: number;
    y: number;
  } | null;
}

export interface InputDecision {
  disposition: "ink" | "navigation" | "tracked" | "rejected" | "cancelled";
  reason:
    | "drawing"
    | "navigation"
    | "disabled"
    | "pen-disabled"
    | "duplicate-contact"
    | "untracked"
    | "palm"
    | "pen-priority"
    | "held-during-pen"
    | "drawing-owned"
    | "finger-disabled"
    | "gesture-wait"
    | "pen-cooldown"
    | "navigation-disabled"
    | "cancelled"
    | "ignored-target"
    | "capture-veto"
    | "mouse-button";
}

export type ContactEffect =
  | { type: "begin" | "points" | "end" | "cancel"; pointerId: number }
  | ({ type: "navigation" } & NavigationTransform)
  | { type: "pen-enabled" };

export type ContactEvent =
  | { type: "down" | "move" | "up" | "cancel"; contact: Contact; now: number }
  | { type: "reset"; now: number; enabled?: boolean; penEnabled?: boolean };

export interface ContactTransition {
  state: ContactState;
  effects: readonly ContactEffect[];
  decision: InputDecision;
}

export function createContactState(
  options: { enabled?: boolean; penEnabled?: boolean } = {},
): ContactState {
  return {
    enabled: options.enabled ?? true,
    penEnabled: options.penEnabled ?? false,
    contacts: new Map(),
    navigationBlocked: new Set(),
    drawing: null,
    lastPenUp: null,
    pinch: null,
  };
}

export function penContactDown(state: ContactState): boolean {
  return [...state.contacts.values()].some((contact) => contact.kind === "pen");
}

/** Shared by drawing navigation and guards around the drawing surface. */
export function withinPenCooldown(
  penDown: boolean,
  lastPenUp: number | null,
  now: number,
  cooldownMs: number,
): boolean {
  return penDown || (lastPenUp !== null && now - lastPenUp < Math.max(0, cooldownMs));
}

export function isPalmContact(contact: Contact, threshold = Number.POSITIVE_INFINITY): boolean {
  return contact.kind === "touch" && (contact.width > threshold || contact.height > threshold);
}

function pinchFor(
  contacts: ReadonlyMap<number, Contact>,
  previous: ContactState["pinch"],
  blocked: ReadonlySet<number>,
  palmContactPx?: number,
): ContactState["pinch"] {
  const fingers = [...contacts.values()].filter(
    (contact) =>
      contact.kind === "touch" &&
      !blocked.has(contact.id) &&
      !isPalmContact(contact, palmContactPx),
  );
  if (fingers.length < 2) return null;
  // An additional contact cannot replace either member of an existing pair.
  const previousPair = previous?.ids.map((id) => fingers.find((finger) => finger.id === id));
  const [a, b] = previousPair?.every(Boolean) ? (previousPair as [Contact, Contact]) : fingers;
  return {
    ids: [a.id, b.id],
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

/** A deterministic transition. Callers own pointer capture, coordinates, and drawing commands. */
export function transitionContact(
  state: ContactState,
  event: ContactEvent,
  options: ContactPolicyOptions = {},
): ContactTransition {
  const reject = (reason: InputDecision["reason"]): ContactTransition => ({
    state,
    effects: [],
    decision: { disposition: "rejected", reason },
  });
  if (event.type === "reset") {
    return {
      state: {
        ...state,
        enabled: event.enabled ?? state.enabled,
        penEnabled: event.penEnabled ?? state.penEnabled,
        contacts: new Map(),
        navigationBlocked: new Set(),
        drawing: null,
        pinch: null,
        lastPenUp: penContactDown(state) ? event.now : state.lastPenUp,
      },
      effects: state.drawing === null ? [] : [{ type: "cancel", pointerId: state.drawing }],
      decision: { disposition: "cancelled", reason: "cancelled" },
    };
  }
  if (!state.enabled) return reject("disabled");
  const contact = event.contact;
  const prior = state.contacts.get(contact.id);
  if (event.type === "down" && prior) return reject("duplicate-contact");
  if (event.type !== "down" && !prior) return reject("untracked");
  if (
    event.type === "down" &&
    contact.kind === "pen" &&
    options.penMode === "explicit" &&
    !state.penEnabled
  ) {
    return reject("pen-disabled");
  }
  const contacts = new Map(state.contacts);
  const navigationBlocked = new Set(state.navigationBlocked);
  const effects: ContactEffect[] = [];
  let drawing = state.drawing;
  let penEnabled = state.penEnabled;
  let lastPenUp = state.lastPenUp;
  let decision: InputDecision = { disposition: "tracked", reason: "gesture-wait" };
  const cancelDrawing = () => {
    if (drawing !== null) effects.push({ type: "cancel", pointerId: drawing });
    drawing = null;
  };
  const begin = () => {
    drawing = contact.id;
    effects.push({ type: "begin", pointerId: contact.id });
    decision = { disposition: "ink", reason: "drawing" };
  };

  if (event.type === "up" || event.type === "cancel") {
    contacts.delete(contact.id);
    navigationBlocked.delete(contact.id);
    if (prior?.kind === "pen") lastPenUp = event.now;
    if (drawing === contact.id) {
      effects.push({ type: event.type === "up" ? "end" : "cancel", pointerId: contact.id });
      drawing = null;
      decision =
        event.type === "up"
          ? { disposition: "ink", reason: "drawing" }
          : { disposition: "cancelled", reason: "cancelled" };
    }
  } else {
    // Palm classification is sticky for the contact: a shrinking palm does not become a finger.
    contacts.set(
      contact.id,
      prior
        ? {
            ...prior,
            x: contact.x,
            y: contact.y,
            width: Math.max(prior.width, contact.width),
            height: Math.max(prior.height, contact.height),
          }
        : { ...contact },
    );
    if (event.type === "down" && penContactDown({ ...state, contacts })) {
      for (const entry of contacts.values()) {
        if (entry.kind === "touch") navigationBlocked.add(entry.id);
      }
    }
    const current = contacts.get(contact.id) as Contact;
    const pinch = pinchFor(contacts, state.pinch, navigationBlocked, options.palmContactPx);
    if (event.type === "down") {
      if (contact.kind === "pen") {
        if (!penEnabled) {
          penEnabled = true;
          effects.push({ type: "pen-enabled" });
        }
        cancelDrawing();
        begin();
      } else if (contact.kind === "mouse") {
        if (drawing === null && !penContactDown({ ...state, contacts })) begin();
        else decision = { disposition: "tracked", reason: "drawing-owned" };
      } else if (isPalmContact(current, options.palmContactPx)) {
        decision = { disposition: "tracked", reason: "palm" };
      } else if (penContactDown({ ...state, contacts })) {
        decision = { disposition: "tracked", reason: "pen-priority" };
      } else if (pinch && (drawing === null || contacts.get(drawing)?.kind === "touch")) {
        cancelDrawing();
      } else if (
        (options.fingerDrawing ?? "until-pen") === "never" ||
        ((options.fingerDrawing ?? "until-pen") === "until-pen" && penEnabled)
      ) {
        decision = { disposition: "tracked", reason: "finger-disabled" };
      } else if (drawing !== null) {
        decision = { disposition: "tracked", reason: "drawing-owned" };
      } else {
        begin();
      }
    } else if (isPalmContact(current, options.palmContactPx)) {
      if (drawing === contact.id) cancelDrawing();
      decision = { disposition: "tracked", reason: "palm" };
    } else if (navigationBlocked.has(contact.id)) {
      decision = {
        disposition: "tracked",
        reason: penContactDown({ ...state, contacts }) ? "pen-priority" : "held-during-pen",
      };
    } else if (drawing === contact.id) {
      effects.push({ type: "points", pointerId: contact.id });
      decision = { disposition: "ink", reason: "drawing" };
    } else if (pinch?.ids.includes(contact.id)) {
      if (
        withinPenCooldown(
          penContactDown({ ...state, contacts }),
          lastPenUp,
          event.now,
          options.navCooldownMs ?? 0,
        )
      ) {
        decision = { disposition: "tracked", reason: "pen-cooldown" };
      } else if (drawing !== null) {
        decision = { disposition: "tracked", reason: "drawing-owned" };
      } else if (options.navigation === false) {
        decision = { disposition: "tracked", reason: "navigation-disabled" };
      } else {
        if (state.pinch && pinch.ids.every((id, i) => id === state.pinch?.ids[i])) {
          const separated = pinch.distance > 0 && state.pinch.distance > 0;
          const angle = pinch.angle - state.pinch.angle;
          effects.push({
            type: "navigation",
            from: { x: state.pinch.x, y: state.pinch.y },
            to: { x: pinch.x, y: pinch.y },
            scale: separated ? pinch.distance / state.pinch.distance : 1,
            rotation: separated ? Math.atan2(Math.sin(angle), Math.cos(angle)) : 0,
          });
          decision = { disposition: "navigation", reason: "navigation" };
        }
      }
    }
  }
  return {
    state: {
      ...state,
      contacts,
      drawing,
      penEnabled,
      lastPenUp,
      navigationBlocked,
      pinch: pinchFor(contacts, state.pinch, navigationBlocked, options.palmContactPx),
    },
    effects,
    decision,
  };
}
