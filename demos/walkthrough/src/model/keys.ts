/**
 * keys.ts — the keyboard layer (playbook layer 4), on the aiui-viz modal kit:
 * one mode, a few bindings — and every binding dispatches through the SAME
 * registered surface the widgets and the agent use (`actionByName` for verbs,
 * the control boxes for values). The hint bar the UI shows is derived from
 * these bindings, so the displayed keymap can never drift from the working
 * one. (The backtick belongs to the aiui intent client — leave it unclaimed.)
 */
import { actionByName, durable } from "@habemus-papadum/aiui-viz";
import { installKeys, type KeyLayer, keyHints, resolveKey } from "@habemus-papadum/aiui-viz/modal";
import { kappa } from "./store";

type Mode = "view";
type Command = "re-seed" | "kappa-up" | "kappa-down";

const LAYERS: readonly KeyLayer<Mode, Command>[] = [
  {
    name: "base",
    fallback: "pass",
    bindings: [
      {
        keys: ["r", "R"],
        down: () => ({ command: "re-seed" }),
        hint: { key: "R", label: "re-seed", tapKey: "r" },
      },
      {
        keys: ["ArrowRight"],
        down: () => ({ command: "kappa-up" }),
        hint: { key: "←→", label: "nudge κ", tapKey: "ArrowRight" },
      },
      { keys: ["ArrowLeft"], down: () => ({ command: "kappa-down" }) },
    ],
  },
];

function dispatch(command: Command): void {
  const step = kappa.meta.step ?? 0.01;
  if (command === "re-seed") actionByName("re-seed")?.run();
  else if (command === "kappa-up") kappa.set((v) => v + step);
  else if (command === "kappa-down") kappa.set((v) => v - step);
}

/** Reactive hint rows — the working keymap, displayed. */
export const hints = () => keyHints(LAYERS, "view" as Mode);

/** Execute a hint tap through the same resolver real keydowns use. */
export function tap(key: string): void {
  const claim = resolveKey(LAYERS, "view" as Mode, key, "down", false);
  if (claim !== "pass" && claim !== "swallow") dispatch(claim.command);
}

// Durable across HMR: exactly one listener set alive.
const box = durable("keyListeners", () => ({ uninstall: undefined as (() => void) | undefined }));
box.uninstall?.();
box.uninstall = installKeys<Mode, Command>({
  stack: LAYERS,
  getState: () => "view",
  dispatch,
});
if (import.meta.hot) {
  import.meta.hot.accept();
}
