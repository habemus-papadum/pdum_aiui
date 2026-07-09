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
 *
 * Solid renders the content (proposal B2.2): {@link ConfigStrip.render}
 * pushes the state into a signal created INSIDE the render root (the
 * ui/widget.tsx pattern — signals created outside never propagate), and the
 * class stays the vanilla facade the modality drives. The `.visible` toggle
 * and the {@link ConfigStrip.open} read stay synchronous classList on the
 * light-DOM root — the keymap reads `open` mid-keydown, before any flush.
 */
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import type { IntentPipelineConfig, KeyCommand } from "../intent-pipeline";
import { engineOf, TRANSCRIPTION_ENGINES } from "../intent-pipeline";

export interface ConfigStripState {
  /** The effective config right now (the strip shows its engine). */
  config: IntentPipelineConfig;
  /** An engine picked mid-thread, applying when the open thread closes. */
  pendingEngine?: string;
  /** True when unsaved session overrides are in effect (lost on reload). */
  sessionDirty: boolean;
  /** True when saved (persisted) overrides exist for this origin. */
  saved: boolean;
  /** A one-line confirmation from the last action ("saved ✓", …). */
  note?: string;
}

/** The linter setting a config runs, for display (absent → off). */
export function displayLinter(config: IntentPipelineConfig): "off" | "openai" | "gemini" {
  return config.linter ?? "off";
}

/** The action row's clickable entries, keyed by their `data-cmd` stamp. */
const ACTION_COMMANDS: Record<string, KeyCommand> = {
  linter: { cmd: "config-linter" },
  save: { cmd: "config-save" },
  reset: { cmd: "config-reset" },
  advanced: { cmd: "config-advanced" },
  close: { cmd: "config-close" },
};

export class ConfigStrip {
  readonly root: HTMLDivElement;
  /** The setter captured from inside the render root (see the constructor). */
  private readonly setState: (state: ConfigStripState) => void;

  /**
   * `onCommand` routes clicks into the SAME dispatch the keymap feeds — the
   * strip stays decision-free. Clicks exist because the chips *look* like
   * buttons: a keyboard-only strip under the armed crosshair cursor read as
   * "broken", not "press 3". One delegated listener reads the rendered
   * `data-tier`/`data-cmd` stamps; Solid only re-renders the content.
   */
  constructor(onCommand?: (command: KeyCommand) => void) {
    this.root = document.createElement("div");
    this.root.className = "mm-config-strip";
    if (onCommand) {
      this.root.addEventListener("click", (event) => {
        const target = event.target as Element | null;
        const chip = target?.closest("[data-engine]");
        if (chip) {
          onCommand({ cmd: "config-engine", index: Number(chip.getAttribute("data-engine")) });
          return;
        }
        const action = target?.closest("[data-cmd]")?.getAttribute("data-cmd");
        if (action && ACTION_COMMANDS[action]) {
          onCommand(ACTION_COMMANDS[action]);
        }
      });
    }

    // The signal lives INSIDE the render root; the component body runs
    // synchronously during render(), so the setter is captured before the
    // constructor returns. Before the first render() call the strip shows
    // nothing — exactly the old empty-innerHTML state.
    let setState: ((state: ConfigStripState) => void) | undefined;
    const Strip = () => {
      const [state, set] = createSignal<ConfigStripState | undefined>(undefined);
      setState = (next) => set(next);
      const layer = (): string => {
        const s = state();
        if (!s) {
          return "";
        }
        return s.sessionDirty
          ? "session — unsaved"
          : s.saved
            ? "saved for this site"
            : "from the file config";
      };
      const chipClass = (engineId: string): string => {
        const s = state();
        let classes = "mm-tier-chip";
        if (s !== undefined && engineId === engineOf(s.config)?.id) {
          classes += " active";
        }
        if (s !== undefined && engineId === s.pendingEngine) {
          classes += " pending";
        }
        return classes;
      };
      return (
        <>
          {state() !== undefined && (
            <div class="mm-strip-title">
              transcriber <span class="mm-strip-layer">{layer()}</span>
            </div>
          )}
          {state() !== undefined && (
            <div class="mm-strip-tiers">
              <For each={TRANSCRIPTION_ENGINES}>
                {(engine, index) => (
                  <span class={chipClass(engine.id)} data-engine={String(index())}>
                    <b>{index() + 1}</b> {engine.icon} {engine.label}
                    <i class="mm-engine-shape"> {engine.shape}</i>
                  </span>
                )}
              </For>
            </div>
          )}
          {state() !== undefined && (
            <div class="mm-strip-linter">
              <span
                class={`mm-tier-chip${displayLinter((state() as ConfigStripState).config) !== "off" ? " active" : ""}`}
                data-cmd="linter"
              >
                <b>L</b> 💡 linter: {displayLinter((state() as ConfigStripState).config)}
              </span>
            </div>
          )}
          {state()?.pendingEngine !== undefined && (
            <div class="mm-strip-pending">
              → {state()?.pendingEngine} applies when this thread closes
            </div>
          )}
          {state()?.note !== undefined && <div class="mm-strip-note">{state()?.note}</div>}
          {state() !== undefined && (
            <div class="mm-strip-actions">
              <span data-cmd="save">
                <b>S</b> save for site
              </span>
              {" · "}
              <span data-cmd="reset">
                <b>R</b> reset to file
              </span>
              {" · "}
              <span data-cmd="advanced">
                <b>G</b> editor
              </span>
              {" · "}
              <span data-cmd="close">
                <b>Esc</b> close
              </span>
            </div>
          )}
        </>
      );
    };
    render(Strip, this.root);
    if (!setState) {
      throw new Error("config strip render did not capture its setter");
    }
    this.setState = setState;
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
    this.setState(state);
  }
}

// HMR guard: the mounted intent tool holds RUNNING closures from this module,
// and a hot swap would strand them on stale code while fresh modules load
// around them (the silent-stale-tab footgun: pushes flow, the view ignores
// them). Declining makes any edit here a full page reload — mount-once code
// has no meaningful hot path.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // decline() is a NO-OP in Vite 5+ — invalidate-on-accept is the working
    // way to say "this module has no hot path": the update re-propagates as
    // if unaccepted and lands as a full page reload.
    import.meta.hot?.invalidate();
  });
}
