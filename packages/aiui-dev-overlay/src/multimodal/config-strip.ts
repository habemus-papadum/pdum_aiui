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
import type { IntentPipelineConfig, IntentTier } from "../intent-pipeline";
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

export class ConfigStrip {
  readonly root: HTMLDivElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "mm-config-strip";
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
      return `<span class="${classes.join(" ")}"><b>${index + 1}</b> ${tier}</span>`;
    }).join("");
    const pending = state.pendingTier
      ? `<div class="mm-strip-pending">→ ${state.pendingTier} applies when this thread closes</div>`
      : "";
    const note = state.note ? `<div class="mm-strip-note">${state.note}</div>` : "";
    this.root.innerHTML = `
      <div class="mm-strip-title">tier <span class="mm-strip-layer">${layer}</span></div>
      <div class="mm-strip-tiers">${chips}</div>
      ${pending}${note}
      <div class="mm-strip-actions"><b>S</b> save for site · <b>R</b> reset to file · <b>G</b> editor · <b>Esc</b> close</div>`;
  }
}
