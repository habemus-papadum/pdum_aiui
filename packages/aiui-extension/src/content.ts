/**
 * Content script: the extension's entire in-page footprint. Panel-first design
 * (browser-extension-intent-tool.md §1): no widget, no command bar — just the
 * minimal indicator (armed ring + dot), and in later steps the ink canvas,
 * selection watcher, and keymap relay.
 *
 * ## HMR (the step-1 checkpoint)
 *
 * CRXJS hot-swaps this module in place. Two rules keep that useful:
 *  - state that must survive a swap lives on `window` (the click counter);
 *  - `import.meta.hot.accept` remounts the indicator from the fresh module, so
 *    an edit is visible without a page reload and without losing the counter.
 */
import { mountIndicator } from "@habemus-papadum/aiui-webext";

/** Edit me for the HMR checkpoint: the indicator badge should update in place. */
const BADGE = "FOO";

interface HmrStash {
  clicks: number;
}

declare global {
  interface Window {
    __aiuiExtStash?: HmrStash;
  }
}

window.__aiuiExtStash ??= { clicks: 0 };
const stash: HmrStash = window.__aiuiExtStash;

const indicator = mountIndicator();
const show = (): void => {
  indicator.set({
    armed: false,
    mode: "",
    badge: stash.clicks > 0 ? `${BADGE} · ${stash.clicks}` : BADGE,
  });
};
indicator.onClick(() => {
  stash.clicks += 1;
  show();
});
show();
console.info(`aiui-extension: content script mounted (badge "${BADGE}", clicks ${stash.clicks})`);

if (import.meta.hot) {
  // Self-accept: the swap re-runs this module, which replaces the indicator
  // host wholesale (mountIndicator sweeps the stale one) and re-reads the
  // stash — an in-place update, page state untouched.
  import.meta.hot.accept();
}
