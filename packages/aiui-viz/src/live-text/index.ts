/**
 * `@habemus-papadum/aiui-viz/live-text` — text revised in front of the user,
 * with one visual language for the change.
 *
 * `wordDiff` is the pure computation (word-level LCS → runs); `LiveDiffText`
 * is the live line: feed it each cumulative text, extensions render at once
 * and revisions flash the word diff before settling (the anti-strobe rule:
 * only rewrites animate). The run classes default to `aiui-diff-del` /
 * `aiui-diff-add`; the tempo constants keep every aiui surface animating at
 * one speed. Consumer: demos/audio's transcript; aiui-stt's `partial` signal
 * is exactly what `update()` wants.
 *
 * Realm rules: `wordDiff` has no DOM (a server-side pipeline can re-export
 * it); the renderer touches the DOM only inside its methods.
 */

export { type DiffRun, wordDiff } from "./diff";
export {
  DEFAULT_DIFF_CLASSES,
  type DiffRunClasses,
  isExtension,
  LIVE_FLASH_MS,
  LiveDiffText,
  type LiveDiffTextOptions,
  renderRuns,
  runsFragment,
  SETTLE_FLASH_MS,
} from "./flash";
