/**
 * The quick-config strip — the K layer's UI.
 *
 * A small panel that sits above the HUD while open and *is* its own
 * documentation: the tier ladder with its digit keys, markers for what is in
 * effect / pending / unsaved, and the action row (save / reset / advanced
 * editor / close). The strip renders state; every decision stays in the
 * modality's dispatch, and the key handling stays in the pure keymap — this
 * file is DOM only.
 *
 * Scope model it displays: a digit picks a tier for **this page session**
 * (nothing persisted); S saves the current config for the site (the same
 * localStorage layer the gear panel writes); R resets to the Vite file config.
 * A tier picked while a thread is open waits for that thread to close — the
 * strip says so — because a thread's hello already told the channel which
 * pipeline to run.
 */
import type { IntentPipelineConfig, IntentTier, KeyCommand } from "../intent-pipeline";
import { TIER_BY_DIGIT } from "../intent-pipeline";

export interface ConfigStripState {
  /** The effective config right now (the strip shows its tier rung). */
  config: IntentPipelineConfig;
  /** A tier picked mid-thread, applying when the open thread closes. */
  pendingTier?: IntentTier;
  /** True when unsaved session overrides are in effect (lost on reload). */
  sessionDirty: boolean;
  /** True when saved (persisted) overrides exist for this origin. */
  saved: boolean;
  /** A one-line confirmation from the last action ("saved ✓", …). */
  note?: string;
}

/** The tier a config runs, for display: explicit `tier` or the default rung. */
export function displayTier(config: IntentPipelineConfig): IntentTier {
  return config.tier ?? "standard";
}

/** The action row's clickable entries, keyed by their `data-cmd` stamp. */
const ACTION_COMMANDS: Record<string, KeyCommand> = {
  save: { cmd: "config-save" },
  reset: { cmd: "config-reset" },
  advanced: { cmd: "config-advanced" },
  close: { cmd: "config-close" },
};

export class ConfigStrip {
  readonly root: HTMLDivElement;

  /**
   * `onCommand` routes clicks into the SAME dispatch the keymap feeds — the
   * strip stays decision-free. Clicks exist because the chips *look* like
   * buttons: a keyboard-only strip under the armed crosshair cursor read as
   * "broken", not "press 3". One delegated listener survives re-renders
   * (render() replaces innerHTML).
   */
  constructor(onCommand?: (command: KeyCommand) => void) {
    this.root = document.createElement("div");
    this.root.className = "mm-config-strip";
    if (onCommand) {
      this.root.addEventListener("click", (event) => {
        const target = event.target as Element | null;
        const chip = target?.closest("[data-tier]");
        if (chip) {
          onCommand({ cmd: "config-tier", tier: chip.getAttribute("data-tier") as IntentTier });
          return;
        }
        const action = target?.closest("[data-cmd]")?.getAttribute("data-cmd");
        if (action && ACTION_COMMANDS[action]) {
          onCommand(ACTION_COMMANDS[action]);
        }
      });
    }
  }

  get open(): boolean {
    return this.root.classList.contains("visible");
  }

  show(state: ConfigStripState): void {
    this.render(state);
    this.root.classList.add("visible");
  }

  hide(): void {
    this.root.classList.remove("visible");
  }

  render(state: ConfigStripState): void {
    const active = displayTier(state.config);
    const layer = state.sessionDirty
      ? "session — unsaved"
      : state.saved
        ? "saved for this site"
        : "from the file config";
    const chips = TIER_BY_DIGIT.map((tier, index) => {
      const classes = ["mm-tier-chip"];
      if (tier === active) {
        classes.push("active");
      }
      if (tier === state.pendingTier) {
        classes.push("pending");
      }
      return `<span class="${classes.join(" ")}" data-tier="${tier}"><b>${index + 1}</b> ${tier}</span>`;
    }).join("");
    const pending = state.pendingTier
      ? `<div class="mm-strip-pending">→ ${state.pendingTier} applies when this thread closes</div>`
      : "";
    const note = state.note ? `<div class="mm-strip-note">${state.note}</div>` : "";
    this.root.innerHTML = `
      <div class="mm-strip-title">tier <span class="mm-strip-layer">${layer}</span></div>
      <div class="mm-strip-tiers">${chips}</div>
      ${pending}${note}
      <div class="mm-strip-actions"><span data-cmd="save"><b>S</b> save for site</span> · <span data-cmd="reset"><b>R</b> reset to file</span> · <span data-cmd="advanced"><b>G</b> editor</span> · <span data-cmd="close"><b>Esc</b> close</span></div>`;
  }
}
