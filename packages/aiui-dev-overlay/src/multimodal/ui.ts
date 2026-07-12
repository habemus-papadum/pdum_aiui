/**
 * The multimodal tool's HOST-AGNOSTIC UI surfaces, as a subpath entry
 * (`@habemus-papadum/aiui-dev-overlay/multimodal-ui`) — the pieces a second
 * host (the browser extension's side panel; Phase C of its plan) mounts
 * verbatim instead of reimplementing:
 *
 *  - {@link Preview} — the transcript preview: a read-only render of the
 *    incremental compiler's accumulator (`composeIntent(events, "replace",
 *    { streaming: true })`), with word-confidence heat, animated diffs, shot
 *    thumbs (hover peek + ✕ → `shot-drop`), and selection pills. Give it an
 *    `Engine`; it subscribes itself.
 *  - {@link CheatSheet} — the live keycap strip for whatever key layers are
 *    active (`update(hints, visible)`); taps synthesize the real key.
 *  - {@link KeymapHelp} — the whole keymap as a table (`render(sections)`),
 *    generated from the same binding rows the resolver reads.
 *  - The stylesheets they need ({@link STYLES} covers the preview's
 *    `mm-preview*` rules; a host that positions them differently overrides
 *    with its own, more specific selectors — the panel does exactly that).
 *
 * Nothing here touches `window.__AIUI__`, the page's DOM, or the overlay's
 * widget: they are DOM-in/DOM-out components over the shared engine.
 */
export { CHEAT_STYLES, CheatSheet, KEYMAP_HELP_STYLES, KeymapHelp } from "./keymap-ui";
export { Preview } from "./preview";
export { HUD_STYLES, STYLES } from "./styles";
