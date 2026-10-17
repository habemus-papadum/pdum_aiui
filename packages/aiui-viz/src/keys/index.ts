/**
 * `@habemus-papadum/aiui-viz/keys` — the key layer: a surface's keyboard as
 * a STACK of layers resolved top-down by a pure function.
 *
 * Bindings answer every key event with a command, `"swallow"` (claimed, do
 * nothing) or `"pass"` (the page keeps it); each layer declares a fallback,
 * so claim-or-pass is exhaustive by construction. `resolveKey` is the pure
 * resolver (table-testable), `keyHints` derives the displayed keymap from
 * the same table, and `installKeys` is the one capture-phase owner on the
 * document, yielding to typing targets. Consumers: aiui-slides' deck,
 * demos/walkthrough. Design history: docs/mode-engine.md.
 *
 * Realm rules: no Solid import, no DOM at module scope — DOM only inside
 * `installKeys`, so the resolver runs in node and in tests as plain data.
 */

export {
  type InstallKeysOptions,
  installKeys,
  isTypingTarget,
  type KeyBinding,
  type KeyClaim,
  type KeyHint,
  type KeyLayer,
  keyHints,
  resolveKey,
} from "./keys";
