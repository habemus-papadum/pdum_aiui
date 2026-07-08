/**
 * The keymap, made visible — two Solid-rendered surfaces over the SAME rows
 * the key resolver reads (the kit's hint column via `intentKeyHints` /
 * `keymapHelp`), so what they show can never drift from what the keys do:
 *
 *  - {@link CheatSheet} — the always-present condensed strip above the pill
 *    while armed: one key-cap pill (+ icon) per live binding *in the current
 *    state*, re-asserted on every renderHud. Labels ride as tooltips; the
 *    strip is meant to be glanceable, not read. It hides while the config
 *    strip is open (that layer displays its own bindings in place).
 *  - {@link KeymapHelp} — the H panel's content: the whole keymap as a
 *    table, one section per mode/layer with its one-line story, generated
 *    from representative states (keymap.ts's `keymapHelp`).
 *
 * Both follow the config-strip pattern (proposal B2.2): Solid renders the
 * content inside a vanilla class facade; the signal lives INSIDE the render
 * root; visibility toggles stay synchronous classList on the light-DOM root.
 */
import { render } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import type { KeyHint } from "@habemus-papadum/aiui-viz/modal";
import type { KeymapHelpSection } from "../intent-pipeline";

/** One key-cap pill (+ optional icon); the label rides as a tooltip. */
const Cap = (props: { hint: KeyHint }) => (
  <span class="mm-keycap" title={props.hint.label}>
    <kbd>{props.hint.key}</kbd>
    <Show when={props.hint.icon !== undefined}>
      <span class="mm-keyicon">{props.hint.icon}</span>
    </Show>
  </span>
);

/** The condensed, always-present per-mode key strip (page-level layers). */
export class CheatSheet {
  readonly root: HTMLDivElement;
  private readonly setHints: (hints: KeyHint[]) => void;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "mm-cheat";
    let setHints: ((hints: KeyHint[]) => void) | undefined;
    const Sheet = () => {
      const [hints, set] = createSignal<KeyHint[]>([]);
      setHints = (next) => set(next);
      return <For each={hints()}>{(hint) => <Cap hint={hint} />}</For>;
    };
    render(Sheet, this.root);
    if (!setHints) {
      throw new Error("cheat sheet render did not capture its setter");
    }
    this.setHints = setHints;
  }

  /** Re-assert the strip from the current state's rows (renderHud calls this). */
  update(hints: KeyHint[], visible: boolean): void {
    this.setHints(hints);
    this.root.classList.toggle("visible", visible && hints.length > 0);
  }
}

/** The H panel's keymap table (widget shadow root — style via hudSlot.addStyle). */
export class KeymapHelp {
  readonly root: HTMLDivElement;
  private readonly setSections: (sections: KeymapHelpSection[]) => void;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "mm-keymap-help";
    let setSections: ((sections: KeymapHelpSection[]) => void) | undefined;
    const Help = () => {
      const [sections, set] = createSignal<KeymapHelpSection[]>([]);
      setSections = (next) => set(next);
      return (
        <For each={sections()}>
          {(section) => (
            <div class="mm-help-section">
              <div class="mm-help-title">
                {section.title}
                <span class="mm-help-note">{section.note}</span>
              </div>
              <For each={section.hints}>
                {(hint) => (
                  <div class="mm-help-row">
                    <kbd>{hint.key}</kbd>
                    <span class="mm-help-icon">{hint.icon ?? ""}</span>
                    <span class="mm-help-label">{hint.label}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      );
    };
    render(Help, this.root);
    if (!setSections) {
      throw new Error("keymap help render did not capture its setter");
    }
    this.setSections = setSections;
  }

  render(sections: KeymapHelpSection[]): void {
    this.setSections(sections);
  }
}

/** The shadow-root styles for {@link KeymapHelp} (inject via hudSlot.addStyle). */
export const KEYMAP_HELP_STYLES = /* css */ `
  /* Columns, not a tower: a fixed-height multicol box — sections flow top to
     bottom and wrap into the next column (never breaking mid-section), and
     when the columns outgrow the panel the box scrolls HORIZONTALLY. No
     vertical scroll, ever. */
  .mm-keymap-help { height: min(420px, 60vh); column-width: 196px; column-gap: 18px;
    column-fill: auto; overflow-x: auto; overflow-y: hidden;
    scrollbar-width: thin; scrollbar-color: #3a4152 transparent;
    font: 11px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #cfd3da; }
  .mm-keymap-help kbd { display: inline-block; min-width: 14px; text-align: center;
    border: 1px solid #3a4152; border-bottom-width: 2px; border-radius: 4px;
    padding: 0 4px; font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #e8e8ea; background: #232936; }
  /* inline-block makes the section ATOMIC in fragmentation — Chrome's
     break-inside: avoid alone gives up around the grid rows and splits a
     section between its note and first row. */
  .mm-help-section { display: inline-block; width: 100%; vertical-align: top;
    break-inside: avoid; margin-bottom: 12px; }
  .mm-help-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #8ab4f8; margin-bottom: 3px; }
  .mm-help-note { display: block; text-transform: none; letter-spacing: 0; color: #6b7280;
    margin: 1px 0 3px; }
  .mm-help-row { display: grid; grid-template-columns: 40px 18px 1fr; gap: 5px;
    align-items: baseline; padding: 1px 0; }
  .mm-help-row kbd { justify-self: start; }
  .mm-help-icon { text-align: center; font-size: 11px; }
  .mm-help-label { color: #9aa0aa; }
`;
