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

import type { KeymapHelpSection } from "@habemus-papadum/aiui-lowering-pipeline";
import type { KeyHint } from "@habemus-papadum/aiui-viz/modal";
import { render } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

/**
 * One cheat-sheet cap — the kit's condensed-surface pattern (see
 * {@link KeyHint.tapKey}): the ICON alone renders; hovering reveals the key
 * as a kbd pill + label (the shared tooltip); clicking synthesizes the key
 * through the same resolver a real keydown uses. A row with no icon falls
 * back to its key cap; a row with no tapKey (a gesture like "drag") renders
 * inert.
 */
const Cap = (props: {
  hint: KeyHint;
  onTap?: (key: string) => void;
  onHover: (hint: KeyHint | undefined, el?: HTMLElement) => void;
}) => {
  let el: HTMLButtonElement | undefined;
  // An EMPTY tapKey is a binding's explicit "keyboard-only" marker (e.g.
  // push-to-talk Space — a mouse can't hold a cap); undefined means the row
  // simply has no key (a gesture like drag). Both render inert.
  const tappable = () => !!props.hint.tapKey && props.onTap !== undefined;
  // `active` is the binding's own report that its mode/state is engaged (the
  // share is sampling, the mic is muted). It reads as a lit cap — and as
  // aria-pressed, because that is exactly what these caps are: toggles.
  const classes = () =>
    ["mm-keycap", tappable() ? "" : "inert", props.hint.active ? "active" : ""]
      .filter(Boolean)
      .join(" ");
  return (
    <button
      type="button"
      class={classes()}
      // The cap renders a bare emoji, which is no name at all to a screen
      // reader (and nothing for a test to aim at). The label already exists —
      // it is what the hover tooltip shows.
      aria-label={props.hint.label}
      aria-pressed={props.hint.active ? "true" : undefined}
      ref={(node: HTMLButtonElement) => (el = node)}
      onMouseEnter={() => props.onHover(props.hint, el)}
      onMouseLeave={() => props.onHover(undefined)}
      onClick={() => {
        const key = props.hint.tapKey;
        if (key) {
          props.onTap?.(key);
        }
      }}
    >
      <Show
        when={props.hint.icon !== undefined || props.hint.iconSvg !== undefined}
        fallback={<kbd>{props.hint.key}</kbd>}
      >
        <Show
          when={props.hint.iconSvg !== undefined}
          fallback={<span class="mm-keyicon">{props.hint.icon}</span>}
        >
          {/* Bundle-owned markup only (see KeyHint.iconSvg's contract). */}
          <span class="mm-keyicon" innerHTML={props.hint.iconSvg} />
        </Show>
      </Show>
    </button>
  );
};

/**
 * The shadow-root styles for {@link CheatSheet} (inject via hudSlot.addStyle).
 * The sheet lives in the widget's BELOW-PILL slot — in flow inside the
 * draggable, bottom-anchored root — so it slides the pill up and follows
 * drags for free. `max-width` is what makes it a compact block instead of a
 * screen-wide bar: the caps flex-wrap into two-ish rows.
 */
export const CHEAT_STYLES = /* css */ `
  .mm-cheat-wrap { position: relative; display: none; }
  .mm-cheat-wrap.visible { display: block; }
  .mm-cheat { display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    max-width: 196px; width: max-content; margin-top: 6px;
    background: #171b25ee; border: 1px solid #262c3a; border-radius: 12px;
    padding: 6px 8px; cursor: default;
    font: 11px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #9aa0aa; }
  .mm-keycap { display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 22px; border: 1px solid transparent; border-radius: 6px;
    background: none; padding: 0; cursor: pointer; }
  .mm-keycap:hover { border-color: #3a4152; background: #232936; }
  /* An ENGAGED mode reads as a lit cap. Green because the sheet has no other
     green — the ring is mode-coloured and the meter is pink — so "something of
     yours is switched on" never collides with "something is recording". Ordered
     after :hover (equal specificity) so a hovered active cap stays lit. */
  .mm-keycap.active { border-color: #4ade80; background: #16261d; }
  .mm-keycap.active:hover { border-color: #6ee7a0; background: #1b2f23; }
  .mm-keycap.inert { cursor: default; }
  .mm-keycap kbd, .mm-cheat-tip kbd { display: inline-block; min-width: 12px; text-align: center;
    border: 1px solid #3a4152; border-bottom-width: 2px; border-radius: 4px;
    padding: 0 4px; font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #cfd3da; background: #232936; }
  .mm-keyicon { font-size: 13px; line-height: 1; }
  /* The hover tooltip: the key as a kbd pill + the label, floated above the
     hovered cap (the pattern's "hover reveals the key"). */
  .mm-cheat-tip { position: absolute; bottom: calc(100% + 2px); left: 0;
    display: flex; align-items: center; gap: 6px; white-space: nowrap;
    background: #171b25; border: 1px solid #3a4152; border-radius: 999px;
    padding: 3px 10px; pointer-events: none; z-index: 1;
    font: 11px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #cfd3da; }
`;

/**
 * The condensed, always-present per-mode key sheet (the widget's below-pill
 * slot): icon-only caps that wrap into a compact block. Hover a cap and a
 * pill tooltip shows its key + label; click it and `onTap` synthesizes the
 * key through the modality's resolver — the same table the keyboard reads.
 */
export class CheatSheet {
  readonly root: HTMLDivElement;
  private readonly setHints: (hints: KeyHint[]) => void;

  constructor(onTap?: (key: string) => void) {
    this.root = document.createElement("div");
    this.root.className = "mm-cheat-wrap";
    let setHints: ((hints: KeyHint[]) => void) | undefined;
    const Sheet = () => {
      const [hints, set] = createSignal<KeyHint[]>([]);
      const [tip, setTip] = createSignal<{ hint: KeyHint; x: number } | undefined>(undefined);
      setHints = (next) => {
        set(next);
        setTip(undefined); // the hovered cap may be gone after a re-render
      };
      const onHover = (hint: KeyHint | undefined, el?: HTMLElement): void => {
        if (hint === undefined || el === undefined) {
          setTip(undefined);
          return;
        }
        setTip({ hint, x: el.offsetLeft });
      };
      return (
        <>
          <Show when={tip() !== undefined}>
            <span class="mm-cheat-tip" style={{ left: `${tip()?.x ?? 0}px` }}>
              <kbd>{tip()?.hint.key}</kbd>
              <span>{tip()?.hint.label}</span>
            </span>
          </Show>
          <div class="mm-cheat">
            <For each={hints()}>
              {(hint) => <Cap hint={hint} onTap={onTap} onHover={onHover} />}
            </For>
          </div>
        </>
      );
    };
    render(Sheet, this.root);
    if (!setHints) {
      throw new Error("cheat sheet render did not capture its setter");
    }
    this.setHints = setHints;
  }

  /** Re-assert the sheet from the current state's rows (renderHud calls this). */
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
                    <Show
                      when={hint.iconSvg !== undefined}
                      fallback={<span class="mm-help-icon">{hint.icon ?? ""}</span>}
                    >
                      <span class="mm-help-icon" innerHTML={hint.iconSvg} />
                    </Show>
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
