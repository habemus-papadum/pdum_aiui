/**
 * modal.ts — the app's modal shell, on the aiui-viz modal kit.
 *
 * Two modal commands to start from, both declared as data:
 *
 *   T   enter *tune* mode — the arrow keys nudge the angle step, Esc (or T)
 *       steps back out, and leaving the window exits too (blurExits).
 *   R   cycle the petal count — a plain command on the base layer.
 *
 * The kit's shape is the point, more than these particular keys: modes live
 * in ONE table (with their Esc ladder and cursor), keys live in LAYERS whose
 * claim-or-pass is explicit, mode-dependent surfaces are asserted from state
 * by a reconciler after every dispatch, and the hint bar the UI shows is
 * derived from the same bindings that execute — so the displayed keymap can
 * never drift from the working one. Grow the app's interactions by adding
 * table rows, bindings, and surface rules here; never by scattering
 * addEventListener("keydown", …) calls.
 *
 * (The backtick key belongs to the aiui intent overlay — leave it unclaimed.)
 */
import { durable } from "@habemus-papadum/aiui-viz";
import {
  blurExitTarget,
  createReconciler,
  escTarget,
  installKeys,
  type KeyLayer,
  keyHints,
  type ModeTable,
  resolveKey,
  runTransition,
} from "@habemus-papadum/aiui-viz/modal";
import {
  ANGLE_STEP_MAX,
  ANGLE_STEP_MIN,
  angleStep,
  type Mode,
  mode,
  PETALS_MAX,
  PETALS_MIN,
  petals,
} from "./store";

type Command = "tune" | "exit" | "cycle-petals" | { nudge: number };

// --- the mode table: modes, Esc ladder, cursors — as data ---------------------

const TABLE: ModeTable<Mode> = {
  initial: "view",
  modes: {
    view: { escParent: null },
    tune: { escParent: "view", cursor: "ew-resize", blurExits: true },
  },
};

// --- keymap layers: claim-or-pass, exhaustive by construction ------------------

const LAYERS: readonly KeyLayer<Mode, Command>[] = [
  {
    name: "tune",
    active: (m) => m === "tune",
    fallback: "pass",
    bindings: [
      {
        keys: ["ArrowRight", "ArrowUp"],
        down: () => ({ command: { nudge: 1 } }),
        hint: { key: "←→", label: "nudge the angle", icon: "🎛️", tapKey: "ArrowRight" },
      },
      { keys: ["ArrowLeft", "ArrowDown"], down: () => ({ command: { nudge: -1 } }) },
      {
        keys: ["Escape", "t", "T"],
        down: () => ({ command: "exit" }),
        hint: { key: "esc", label: "done tuning" },
      },
    ],
  },
  {
    name: "base",
    fallback: "pass",
    bindings: [
      {
        keys: ["t", "T"],
        down: () => ({ command: "tune" }),
        hint: { key: "T", label: "tune the angle", icon: "🎚️" },
      },
      {
        keys: ["r", "R"],
        down: () => ({ command: "cycle-petals" }),
        hint: { key: "R", label: "next petal count", icon: "🌸" },
      },
    ],
  },
];

// --- surfaces: asserted from state after every event, never toggled ------------

const reconcile = createReconciler<Mode>([
  {
    name: "cursor",
    apply: (m) => {
      document.body.style.cursor = TABLE.modes[m].cursor ?? "";
    },
  },
  {
    // styles.css keys off body[data-mode="tune"] to spotlight the slider.
    name: "mode-attr",
    apply: (m) => {
      document.body.dataset.mode = m;
    },
  },
]);

// --- transitions & dispatch -----------------------------------------------------
//
// Solid 2.0 commits signal writes transactionally: a `mode.get()` in the same
// synchronous scope as a `mode.set(...)` still sees the OLD value. So the
// dispatcher threads the mode it computed forward (into reconcile) instead of
// re-reading the signal after writing it.

function transition(from: Mode, to: Mode): Mode {
  mode.set(runTransition(TABLE, from, to));
  return to;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function dispatch(command: Command): void {
  let m = mode.get();
  if (typeof command === "object") {
    angleStep.set(clamp(angleStep.get() + command.nudge, ANGLE_STEP_MIN, ANGLE_STEP_MAX));
  } else if (command === "tune") {
    m = transition(m, "tune");
  } else if (command === "exit") {
    const target = escTarget(TABLE, m);
    if (target) m = transition(m, target);
  } else if (command === "cycle-petals") {
    const p = petals.get();
    petals.set(p >= PETALS_MAX ? PETALS_MIN : p + 1);
  }
  reconcile(m);
}

// --- the UI-facing surface --------------------------------------------------------

/** Reactive hint rows for the current mode — the working keymap, displayed. */
export const hints = () => keyHints(LAYERS, mode.get());

/** Execute a hint tap through the same resolver real keydowns use. */
export function tap(key: string): void {
  const claim = resolveKey(LAYERS, mode.get(), key, "down", false);
  if (claim !== "pass" && claim !== "swallow") dispatch(claim.command);
}

// --- installation (durable across HMR: exactly one listener set alive) -------------

const listenerBox = durable("modalListeners", () => ({
  uninstall: undefined as (() => void) | undefined,
}));
listenerBox.uninstall?.(); // an HMR re-evaluation replaces the previous installation

const uninstallKeys = installKeys<Mode, Command>({
  stack: LAYERS,
  getState: () => mode.get(),
  dispatch,
});
const onBlur = () => {
  const m = mode.get();
  const target = blurExitTarget(TABLE, m);
  if (target) {
    reconcile(transition(m, target));
  }
};
window.addEventListener("blur", onBlur);
listenerBox.uninstall = () => {
  uninstallKeys();
  window.removeEventListener("blur", onBlur);
};

reconcile(mode.get()); // assert surfaces for the restored mode (HMR mid-tune)
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    console.info("[app:hmr] modal shell reloaded — keymap and surfaces reinstalled");
  });
}
