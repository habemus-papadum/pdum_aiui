/**
 * Shared prompt-context assembly: the connection-context preamble every format
 * wraps a user prompt in.
 *
 * Extracted from `text-concat` so the `intent-v1` lowering reuses the exact
 * same tab/source/selection blocks instead of duplicating them — the two
 * formats must produce identical context wording so a trace reads the same
 * whichever modality lowered it. {@link augmentTextPrompt} is the one place that
 * wording lives; {@link asSelection} normalizes a loosely-typed selection block
 * the same way for both formats.
 */
import type { HelloMeta } from "./frame";

/**
 * An on-screen selection a frame may carry (the intent tool's
 * `SelectionSnapshot` minus its capture timestamp). Everything is optional; the
 * augmentation only uses `text` and the attribution fields, and drops the whole
 * block when there is no text.
 */
export interface SelectionContext {
  /** The selected text. */
  text?: string;
  /** `data-source-loc` (`file:line:col`) of the selection's origin element. */
  sourceLoc?: string;
  /** `data-cell` (dataflow node) of the selection's origin element. */
  cell?: string;
  /** TeX source when the selection is rendered mathematics. */
  tex?: string;
  /** The page URL the selection came from. */
  url?: string;
}

/**
 * Normalize a `{ selection }` block out of an arbitrary object, loosely:
 * unknown/wrong shapes yield undefined rather than throwing (a selection is
 * enrichment, never a reason to reject input), and only string fields we
 * understand are kept. Returns undefined unless there is selection text to talk
 * about.
 */
export const asSelection = (payload: unknown): SelectionContext | undefined => {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const { selection } = payload as Record<string, unknown>;
  if (selection === null || typeof selection !== "object") {
    return undefined;
  }
  const raw = selection as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  const text = str(raw.text);
  if (text === undefined) {
    return undefined;
  }
  const sourceLoc = str(raw.sourceLoc);
  const cell = str(raw.cell);
  const tex = str(raw.tex);
  const url = str(raw.url);
  return {
    text,
    ...(sourceLoc !== undefined ? { sourceLoc } : {}),
    ...(cell !== undefined ? { cell } : {}),
    ...(tex !== undefined ? { tex } : {}),
    ...(url !== undefined ? { url } : {}),
  };
};

/**
 * Wrap a user's text in the context the connection's hello provided: which
 * browser tab it came from (with the routing caveats an agent needs) and where
 * the page's source code lives. Returns the text unchanged when there is no
 * context to add — a bare client (no plugin, no extension) still works.
 *
 * The tab ids are labeled as *hints* on purpose: Chrome's extension tab id,
 * the CDP target id, and the Chrome DevTools MCP's pageId are three different
 * namespaces, and only `list_pages` can produce the last one (see the
 * session-browser skill, which this preamble points the agent at).
 */
export function augmentTextPrompt(
  text: string,
  meta: HelloMeta | undefined,
  selection?: SelectionContext,
): string {
  const tab = meta?.tab;
  const source = meta?.source;
  const sections: string[] = [];

  if (tab !== undefined && (tab.url !== undefined || tab.title !== undefined)) {
    const hints: string[] = [];
    if (tab.chromeTabId !== undefined) {
      hints.push(`chrome tab id ${tab.chromeTabId}`);
    }
    if (tab.windowId !== undefined) {
      hints.push(`window id ${tab.windowId}`);
    }
    if (tab.tabIndex !== undefined) {
      hints.push(`tab index ${tab.tabIndex}`);
    }
    if (tab.targetId !== undefined) {
      hints.push(`CDP target id ${tab.targetId}`);
    }
    sections.push(
      [
        `It was submitted from the browser tab "${tab.title ?? "(untitled)"}" at ${tab.url ?? "(unknown url)"}`,
        hints.length > 0 ? ` (${hints.join(", ")})` : "",
        ".\n",
        "To act on that tab with the Chrome DevTools MCP: the ids above are correlation hints only — ",
        "call list_pages, match by URL/title, then select_page with the pageId list_pages returned, ",
        "and verify you selected the right page. The session-browser skill covers this workflow.",
      ].join(""),
    );
  }

  if (source?.root !== undefined) {
    sections.push(`The source code of the web app in that tab is located at: ${source.root}`);
  }

  if (selection?.text) {
    const attribution: string[] = [];
    if (selection.sourceLoc !== undefined) {
      attribution.push(`authored at ${selection.sourceLoc}`);
    }
    if (selection.cell !== undefined) {
      attribution.push(`produced by cell ${selection.cell}`);
    }
    const lines = [
      `It concerns this on-screen selection: "${selection.text}"${
        attribution.length > 0 ? ` (${attribution.join("; ")})` : ""
      }.`,
    ];
    if (selection.tex !== undefined) {
      lines.push(`The selected content is rendered mathematics; its TeX source: ${selection.tex}`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    return text;
  }
  return [
    "This prompt was sent from the aiui web intent tool running in a web app under development.",
    ...sections,
    "The user's prompt follows.",
    "---",
    text,
  ].join("\n\n");
}
