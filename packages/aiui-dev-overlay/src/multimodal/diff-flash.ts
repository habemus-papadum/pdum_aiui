/**
 * The diff-flash lives in the modal kit now (`aiui-viz/modal` — extracted per
 * aiui-viz's handoff/modal-interaction-lessons.md §1 so every aiui surface
 * flashes text changes in one visual language at one tempo). The kit's
 * defaults ARE this overlay's historical `mm-diff-del` / `mm-diff-add`
 * classes and 450 ms live tempo, so this module is a pure re-export kept as
 * the multimodal surface's local import site.
 */
export {
  isExtension,
  LIVE_FLASH_MS,
  LiveDiffText,
  renderRuns,
  runsFragment,
  SETTLE_FLASH_MS,
} from "@habemus-papadum/aiui-viz/modal";
