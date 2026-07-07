/**
 * Shared prompt-context assembly: the connection-context preamble every format
 * wraps a user prompt in.
 *
 * Extracted from `text-concat` so the `intent-v1` lowering reuses the exact
 * same tab/source/selection blocks instead of duplicating them — the two
 * formats must produce identical context wording so a trace reads the same
 * whichever modality lowered it. The wording lives in exactly one place —
 * {@link promptContextSections} / {@link selectionSections} build the blocks and
 * {@link wrapWithContext} encloses them — which lets a streaming processor
 * pre-warm the hello-fixed part (tab/source) and defer only the body and the
 * late selection to `fin`, while `text-concat` still calls the all-in-one
 * {@link augmentTextPrompt}. {@link asSelection} normalizes a loosely-typed
 * selection block the same way for both formats.
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
 * The tab + source context sections — everything the hello fixes at connect
 * time, independent of the (late-arriving) on-screen selection. Split out from
 * {@link augmentTextPrompt} so a processor can **pre-warm** this skeleton once
 * at thread-open and only concatenate the body + selection at `fin` (the
 * incremental-lowering seam; see streaming-turns.md §2). Empty for a bare
 * client with no tab/source context.
 *
 * The tab ids are labeled as *hints* on purpose: Chrome's extension tab id,
 * the CDP target id, and the Chrome DevTools MCP's pageId are three different
 * namespaces, and only `list_pages` can produce the last one (see the
 * session-browser skill, which this preamble points the agent at).
 */
export function promptContextSections(meta: HelloMeta | undefined): string[] {
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

  return sections;
}

/**
 * The on-screen-selection section — the CONTEXT-CHUNK path only: the text
 * modality's submit-time selection (`text-concat`) and older `intent-v1`
 * clients' legacy `context` frame. Current intent-v1 clients ride selections
 * on the stream as positional `app-selection` events, which `composeIntent`
 * renders INLINE in the prompt body at their stream position — those never
 * pass through here. Returns `[]` when there is no selection text to talk
 * about.
 */
export function selectionSections(selection: SelectionContext | undefined): string[] {
  if (!selection?.text) {
    return [];
  }
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
  return [lines.join("\n")];
}

/**
 * Wrap a user prompt in already-assembled context sections. The one place the
 * enclosing wording lives — {@link augmentTextPrompt} and the `intent-v1`
 * lowering both feed it their sections so the two formats stay byte-identical.
 * No sections → the text is returned unchanged (a bare client still works).
 */
export function wrapWithContext(sections: string[], text: string): string {
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

/**
 * Wrap a user's text in the context the connection's hello provided: which
 * browser tab it came from (with the routing caveats an agent needs), where
 * the page's source code lives, and any on-screen selection. Returns the text
 * unchanged when there is no context to add — a bare client (no plugin, no
 * extension) still works.
 */
export function augmentTextPrompt(
  text: string,
  meta: HelloMeta | undefined,
  selection?: SelectionContext,
): string {
  return wrapWithContext([...promptContextSections(meta), ...selectionSections(selection)], text);
}
