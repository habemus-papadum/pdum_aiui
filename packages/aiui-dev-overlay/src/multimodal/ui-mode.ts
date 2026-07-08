/**
 * `UiMode` — the interaction handoff's §B.4, made real: ONE derived, pure,
 * unit-testable answer to "what mode is the overlay in", replacing the
 * scattered-boolean presentation (armed/mode/talking/threadOpen/shooting each
 * read separately by whoever cared). The modality derives it after every
 * dispatch/engine event; the HUD ring, the reconciler surfaces, and the agent
 * surface's `report()` all read THIS, so the user, the tests, and the session
 * agree on the mode by construction.
 *
 * The mode is a *projection* — the engine's fields plus the shell's transient
 * `shooting` flag in, one name out. Nothing stores it; storing a derived mode
 * is how presentation drifts from truth.
 *
 * Precedence (first match wins): tweaking/vscode > shooting > talking >
 * composing > ready. The engine-mode pair first (they never compete — the
 * engine holds exactly one mode) because each re-routes pointer and keys
 * wholesale: tweak and vscode modes release them to the app (vscode keeps
 * only the double-click gesture; and the veil guard clears `shooting` on
 * entering either); `shooting` above `talking` because the veil is the more
 * transient, more consequential surface — it owns every pointer event while
 * up, and the ring should say so even mid-REC (ink stays drawable while
 * talking, so talking otherwise looks like composing).
 */
import type { ModeTable } from "@habemus-papadum/aiui-viz/modal";
import type { Mode } from "../intent-pipeline";

export type UiMode = "off" | "ready" | "composing" | "shooting" | "talking" | "tweaking" | "vscode";

/** The raw predicates the projection reads (engine fields + shell flags). */
export interface UiModeInputs {
  armed: boolean;
  mode: Mode;
  talking: boolean;
  threadOpen: boolean;
  /** The shot veil is armed (D held / drag in flight) — shell-owned. */
  shooting: boolean;
}

export function uiMode(inputs: UiModeInputs): UiMode {
  if (!inputs.armed) {
    return "off";
  }
  if (inputs.mode === "tweak") {
    return "tweaking";
  }
  if (inputs.mode === "vscode") {
    return "vscode";
  }
  if (inputs.shooting) {
    return "shooting";
  }
  if (inputs.talking) {
    return "talking";
  }
  return inputs.threadOpen ? "composing" : "ready";
}

/**
 * The mode table as kit data. Two columns are live today: `cursor` (asserted
 * by the reconciler — the mode-wide crosshair is part of the mode contract,
 * lessons rule 10) and the ring color via {@link RING_CLASS}-equivalent
 * `data-ui-mode` styling. `escParent` documents the §B.4 ladder the dispatch
 * implements with engine verbs (tweak → ink, cancel thread, disarm);
 * step-out keeps its verb form because "cancel the thread" and "leave tweak
 * mode" are engine transitions, not UiMode writes — the column is here so
 * the ladder has one declarative home.
 *
 * Cursor note: every armed mode asserts the crosshair, matching the
 * historical `body.mm-armed` behavior; surfaces that must opt out (the
 * config strip's chips) assert their own cursor, per the same rule. The
 * exceptions are `tweaking` and `vscode`: the crosshair is capture's cursor,
 * and both release capture — pointer and keyboard belong to the page (vscode
 * mode claims only the double-click), so the page's own cursors must show
 * (hence no cursor in their rows).
 */
export const UI_MODE_TABLE: ModeTable<UiMode> = {
  initial: "off",
  modes: {
    off: { escParent: null },
    ready: { escParent: "off", cursor: "crosshair" },
    composing: { escParent: "ready", cursor: "crosshair" },
    shooting: { escParent: "composing", cursor: "crosshair" },
    talking: { escParent: "composing", cursor: "crosshair" },
    tweaking: { escParent: "composing" },
    // blurExits: the mode's whole purpose is a round-trip out of the page (a
    // jump lands you in the editor, blurring this window) — coming back must
    // resume composing, not a forgotten double-click trap. The modality's
    // blur handler consults the column via the kit's blurExitTarget.
    vscode: { escParent: "composing", blurExits: true },
  },
};
