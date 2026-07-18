/**
 * Keymap layers with exhaustive claims (modal-interaction-lessons §4.2, rules
 * §3.2/3/8/9).
 *
 * A modal surface's keyboard behavior is a STACK of layers resolved top-down
 * by a pure function — table-testable across state × key × phase × repeat,
 * which is where every keymap redesign gets cheap. The structure encodes the
 * rules the retired dev overlay paid ~15 debugging rounds to learn:
 *
 *  - **Claim-or-pass is explicit, including repeats and keyups.** A binding
 *    answers with a command, `"swallow"` (claimed, do nothing — the inert
 *    command that stops held-key repeats from scrolling the page while an
 *    async acquisition is still in flight), or `"pass"` (the page keeps the
 *    key). A layer declares a `fallback` for keys it doesn't bind, so
 *    exhaustiveness is structural, not remembered.
 *  - **Layers, not modes, for key-claiming UI.** A config strip or dialog
 *    pushes a layer that claims a few keys while everything below keeps its
 *    meaning. Layers activate on a state predicate, so the stack itself is
 *    static data.
 *  - **One event-capture owner.** `installKeys` listens on the document in
 *    the capture phase; component-level `stopPropagation` cannot defend
 *    against it, so the contract is that the keymap yields to typing targets
 *    ({@link isTypingTarget}, composedPath-aware so shadow-DOM inputs count)
 *    and components never fight the keymap. Known holes to document per app:
 *    widgets handling keys on non-editable elements; iframes are unreachable,
 *    hence naturally safe.
 *
 * Releases must be unconditional and idempotent (rule §3.3) and dangerous
 * global gestures must be re-bound inside editing modes (rule §3.8) — both
 * are binding-author responsibilities; the shape here just makes them
 * writable as table rows.
 */

/** A binding's (or layer's) answer for one key event. */
export type KeyClaim<C> = { command: C } | "swallow" | "pass";

/**
 * A binding's display row for cheat sheets and help: key cap + meaning.
 *
 * The house pattern for condensed surfaces: render the ICON only, reveal the
 * key (a kbd pill) + label on hover, and execute on click by synthesizing
 * `tapKey` through the same resolver real keydowns use — so a tap can never
 * drift from what the key does.
 */
export interface KeyHint {
  /** Display key cap, e.g. "␣", "D", "esc", "↑↓". */
  key: string;
  /** Short meaning, e.g. "talk", "region shot". */
  label: string;
  /** Optional pictogram for the condensed cheat sheet (an emoji works). */
  icon?: string;
  /** Visual tone for the cap (renderers map it to a class, e.g. "danger"). */
  tone?: string;
  /**
   * This row's mode/state is currently ENGAGED — the share is sampling, the
   * mic is muted, tweak mode has the pointer. Condensed surfaces highlight
   * such a cap, so "what is on right now" is readable at a glance instead of
   * being inferred from a label that only appears on hover.
   *
   * A binding reports it from its own `hint(state)`, which keeps the fact next
   * to the binding that owns it — the same reason the hint column exists.
   */
  active?: boolean;
  /**
   * The real `KeyboardEvent.key` a UI tap synthesizes to EXECUTE this row.
   * {@link keyHints} fills it from the binding's first key; a synthetic
   * gesture row (e.g. "drag") has none and renders non-clickable.
   */
  tapKey?: string;
}

export interface KeyBinding<S, C> {
  /** `KeyboardEvent.key` values this binding matches, exactly (list both cases for letters). */
  keys: readonly string[];
  /** Answer for keydown; omitted = "pass". Receives the matched key and the repeat flag. */
  down?: (state: S, key: string, repeat: boolean) => KeyClaim<C>;
  /** Answer for keyup; omitted = "pass". */
  up?: (state: S, key: string) => KeyClaim<C>;
  /**
   * Display metadata for cheat sheets and help ({@link keyHints}) — declared
   * on the binding itself, so what the UI shows can never drift from what
   * the key does. The function form lets a state-dependent binding describe
   * itself per state (Enter: "send" vs "done editing"); returning undefined
   * hides the binding in that state.
   */
  hint?: KeyHint | ((state: S) => KeyHint | undefined);
}

export interface KeyLayer<S, C> {
  /** Names appear in tests and traces. */
  name: string;
  /** Layer participates only while this holds (omitted = always). */
  active?: (state: S) => boolean;
  bindings: readonly KeyBinding<S, C>[];
  /**
   * The layer's answer for keys it binds nothing for: `"pass"` hands them to
   * the next layer down (and ultimately the page); `"swallow"` claims the
   * whole keyboard (a blocking dialog). Mandatory on purpose.
   */
  fallback: "pass" | "swallow";
}

/**
 * Resolve one key event through the stack, top-down. The first non-"pass"
 * answer wins; a matched binding with no handler for this phase passes (a
 * down-only binding does not eat keyups). If every active layer passes, the
 * page keeps the event.
 */
export function resolveKey<S, C>(
  stack: readonly KeyLayer<S, C>[],
  state: S,
  key: string,
  phase: "down" | "up",
  repeat: boolean,
): KeyClaim<C> {
  for (const layer of stack) {
    if (layer.active && !layer.active(state)) {
      continue;
    }
    const binding = layer.bindings.find((b) => b.keys.includes(key));
    if (!binding) {
      if (layer.fallback === "swallow") {
        return "swallow";
      }
      continue;
    }
    const claim =
      phase === "down"
        ? (binding.down?.(state, key, repeat) ?? "pass")
        : (binding.up?.(state, key) ?? "pass");
    if (claim !== "pass") {
      return claim;
    }
    // A binding that answered "pass" deliberately releases the key: it skips
    // its own layer's fallback (unlike an unbound key, which hits it) and
    // falls through to the layers below. An explicit pass is a choice — a
    // swallow-fallback layer that wants a key claimed must claim it, not
    // pass it.
  }
  return "pass";
}

/**
 * The active hint rows for a state, resolved through the stack top-down with
 * claim shadowing: a key bound by a higher active layer hides the same key's
 * hints below (a strip claiming S for "save" hides the base layer's S
 * "viewport shot"), exactly mirroring {@link resolveKey}'s precedence — a
 * binding with no hint still shadows. Order: layers top-down, bindings in
 * declaration order; a swallow-fallback layer ends the walk (nothing below
 * is reachable). Drive per-mode cheat sheets and help tables from THIS, so
 * the displayed keymap and the working keymap are the same table.
 */
export function keyHints<S, C>(stack: readonly KeyLayer<S, C>[], state: S): KeyHint[] {
  const hints: KeyHint[] = [];
  const claimed = new Set<string>();
  for (const layer of stack) {
    if (layer.active && !layer.active(state)) {
      continue;
    }
    for (const binding of layer.bindings) {
      const fresh = binding.keys.some((key) => !claimed.has(key));
      for (const key of binding.keys) {
        claimed.add(key);
      }
      if (!fresh) {
        continue;
      }
      const hint = typeof binding.hint === "function" ? binding.hint(state) : binding.hint;
      if (hint !== undefined) {
        // The binding's first key is what a UI tap synthesizes (the hint may
        // override; a display-only row can set tapKey itself or stay inert).
        hints.push({ tapKey: binding.keys[0], ...hint });
      }
    }
    if (layer.fallback === "swallow") {
      break;
    }
  }
  return hints;
}

/**
 * True when the key event is aimed at something text-editable, so the keymap
 * must not swallow it. Covers native inputs/textareas, `contenteditable`
 * (which is what most web editors — ProseMirror, Lexical, Quill, CodeMirror —
 * ultimately focus), ARIA textboxes, and, via composedPath, inputs hidden
 * inside shadow DOM (where event.target at the document is only the host).
 * Known hole: a widget that handles keys on a plain non-editable element;
 * nothing observable distinguishes it from the page. Editors inside iframes
 * are unreachable by this listener entirely, hence naturally safe.
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
    ) !== null
  );
}

export interface InstallKeysOptions<S, C> {
  stack: readonly KeyLayer<S, C>[];
  getState: () => S;
  dispatch: (command: C) => void;
  /** Typing-target guard; defaults to {@link isTypingTarget}. */
  isTyping?: (event: KeyboardEvent) => boolean;
  /** Listener host; defaults to `document`. */
  target?: Pick<Document, "addEventListener" | "removeEventListener">;
}

/**
 * Bind the stack to the document (capture phase — the one event-capture
 * owner). Claimed events (commands AND swallows) are preventDefault-ed and
 * stopPropagation-ed; passes are untouched. Returns the uninstall function.
 */
export function installKeys<S, C>(options: InstallKeysOptions<S, C>): () => void {
  const isTyping = options.isTyping ?? isTypingTarget;
  const target = options.target ?? document;
  const handler = (phase: "down" | "up") => (event: KeyboardEvent) => {
    if (isTyping(event)) {
      return;
    }
    const claim = resolveKey(options.stack, options.getState(), event.key, phase, event.repeat);
    if (claim === "pass") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (claim !== "swallow") {
      options.dispatch(claim.command);
    }
  };
  const down = handler("down") as EventListener;
  const up = handler("up") as EventListener;
  target.addEventListener("keydown", down, true);
  target.addEventListener("keyup", up, true);
  return () => {
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("keyup", up, true);
  };
}
