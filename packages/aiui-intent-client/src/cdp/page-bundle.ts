/**
 * page-bundle.ts — the REAL page-side surfaces for CDP-driven pages. The
 * sidecar builds this module into a self-contained IIFE (sidecar.ts
 * `pageBundle()`, served at `/intent/page-bundle.js`); the panel reads it from
 * its OWN origin and the bus `Runtime.evaluate`s it into the page (cdp-bus's
 * `ensureBundle`). The page fetches nothing — an https page may not import
 * from the channel's http origin (mixed content; see page-script.ts).
 *
 * What rides the bundle: the component locator (region drags → components →
 * source), jump-to-editor, and the pencil markup surface. The bootstrap calls
 * them through the `__aiuiIntentPage` global.
 */

// The component locator rides the same evaluated bundle: the bootstrap calls
// `__aiuiIntentPage.locateComponents(rect)` when a region drag completes on an
// aiui-instrumented page (data-source-loc stamps → LocatedComponent[]).
export { locateComponents } from "@habemus-papadum/aiui-intent-runtime/locator";

// Jump-to-editor rides here too: the bootstrap's `jump` capability calls
// `__aiuiIntentPage.armJump()` / `disarmJump()` (see ../page/jump-mode.ts).
export { armJump, disarmJump } from "../page/jump-mode";

// The pencil surface rides the same evaluated bundle: the bootstrap's `pencil`
// capability calls `__aiuiIntentPage.mountPencil()` (see ../page/pencil-mount.ts).
export { mountPencil, type PencilHandle } from "../page/pencil-mount";
