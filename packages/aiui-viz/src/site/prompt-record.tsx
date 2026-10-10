/**
 * prompt-record.tsx — a STORED prompt record (the prompt toolkit's semantic
 * record, as a ledger keeps it) previewed in place by the toolkit's
 * inspector: the rendered Markdown, the exact text, and the full inspector
 * on demand.
 *
 * The inspector (`@habemus-papadum/aiui-prompts-inspector`, with KaTeX and a
 * Markdown parser behind it) is an OPTIONAL peer loaded on first use, so a
 * page that never opens a record never ships it; the oracle's and the live
 * session's ledger widgets mount this wherever an entry carries a record.
 * The wrapper opts into the inspector's aiui token bridge, so the preview
 * follows the host's design tokens instead of the inspector's neutral light
 * defaults.
 *
 * What a reader gets that the sent string cannot give: the record is what
 * the ledger holds, and the inspector recompiles it with the recorded
 * compiler — no author code, no current session state — so the text shown
 * is what the record reproduces, with every piece attributed to the tool
 * snapshot or the imported text it came from.
 */

import type { PromptPreviewProps } from "@habemus-papadum/aiui-prompts-inspector";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";

type Preview = (props: PromptPreviewProps) => JSX.Element;

/** The `<style>` this module owns in a document, by its marker attribute. */
const STYLE_MARK = "data-aiui-prompt-inspector";

let loading: Promise<Preview> | undefined;

/**
 * The inspector, loaded once per document — with its stylesheets injected as
 * one `<style>` (the inspector exports them as strings, so this needs no CSS
 * import and no bundler contract for one): the neutral base and the aiui
 * token bridge the wrapper below opts into.
 */
function loadPreview(): Promise<Preview> {
  loading ??= import("@habemus-papadum/aiui-prompts-inspector").then((inspector) => {
    if (
      typeof document !== "undefined" &&
      document.head.querySelector(`[${STYLE_MARK}]`) === null
    ) {
      const style = document.createElement("style");
      style.setAttribute(STYLE_MARK, "");
      style.textContent = `${inspector.INSPECTOR_STYLES.base}\n${inspector.INSPECTOR_STYLES.themes.aiui}`;
      document.head.append(style);
    }
    return inspector.PromptPreview;
  });
  return loading;
}

export interface PromptRecordViewProps {
  /** The stored record, as the ledger holds it (plain JSON). */
  record: unknown;
  /** Start on the rendered Markdown (the default) or on the exact text. */
  initialView?: "markdown" | "text";
}

/**
 * The preview of one stored record. Shows a one-line placeholder until the
 * inspector has loaded, then the inspector's compact view with its own
 * Markdown / Text toggle and "Open full inspector" button.
 */
export function PromptRecordView(props: PromptRecordViewProps) {
  const [preview, setPreview] = createSignal<Preview>();
  const [failure, setFailure] = createSignal<string>();
  loadPreview()
    .then((component) => setPreview(() => component))
    .catch((error) => setFailure(`the prompt inspector failed to load: ${String(error)}`));
  // The component is CALLED inside a memo (not placed as JSX): the accessor
  // read is tracked there, the mounted preview's reactive scope is owned by
  // the memo, and the record arrives as a getter so a replaced record reaches
  // the preview's own effects instead of remounting it.
  const view = createMemo((): JSX.Element => {
    const Component = preview();
    if (Component === undefined) {
      return (
        <span class="aiui-prompt-record-loading">
          {failure() ?? "loading the prompt inspector…"}
        </span>
      );
    }
    return Component({
      get record() {
        return props.record;
      },
      get initialView() {
        return props.initialView;
      },
    });
  });
  return (
    <div class="aiui-prompt-record" data-prompt-theme="aiui">
      {view()}
    </div>
  );
}
