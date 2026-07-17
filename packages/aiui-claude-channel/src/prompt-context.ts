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
import { renderTabRecord, type TabRecord } from "@habemus-papadum/aiui-lowering-pipeline";
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
  /** That cell's definition site (`file:line` — the `cell(...)` call), when stamped. */
  cellLoc?: string;
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
  const cellLoc = str(raw.cellLoc);
  const tex = str(raw.tex);
  const url = str(raw.url);
  return {
    text,
    ...(sourceLoc !== undefined ? { sourceLoc } : {}),
    ...(cell !== undefined ? { cell } : {}),
    ...(cellLoc !== undefined ? { cellLoc } : {}),
    ...(tex !== undefined ? { tex } : {}),
    ...(url !== undefined ? { url } : {}),
  };
};

/**
 * The note appended to the preamble when the turn contains SPEECH-transcribed
 * text (the intent lowering adds it; typed contributions never trigger it).
 * Exported so the section list and its tests share one string.
 */
export const TRANSCRIPTION_NOTE =
  "Portions of the prompt were transcribed and might have transcription errors.";

/**
 * The tab + source context sections — everything the hello fixes at connect
 * time. Split out from {@link augmentTextPrompt} so a processor can
 * **pre-warm** this skeleton once at thread-open and only concatenate the
 * body + turn-dependent sections at `fin` (the incremental-lowering seam; see
 * streaming-turns.md §2). Empty for a bare client with no tab/source context.
 *
 * Honesty rules (2026-07-17 render audit):
 * - "web app under development" and the relative-paths line appear only when
 *   an aiui app was DETECTED — interim signal: the hello carried a source
 *   root (the vite plugin stamps it). The side panel sits on arbitrary
 *   pages; those get the neutral opening line.
 * - The tab renders as the canonical `<tab …/>` element
 *   ({@link renderTabRecord}) — the same record used at navigation/tab-switch
 *   boundaries and in selection metadata. The MCP server's instructions teach
 *   the element once (ids are correlation hints; match via `list_pages` by
 *   url/title), so the per-turn preamble carries data, not lessons.
 */
export function promptContextSections(meta: HelloMeta | undefined): string[] {
  const tab = meta?.tab;
  const source = meta?.source;
  const aiui = source?.root !== undefined;
  const sections: string[] = [];

  const hasTab = tab !== undefined && (tab.url !== undefined || tab.title !== undefined);
  if (hasTab || aiui) {
    sections.push(
      aiui
        ? "This prompt was sent from the aiui intent tool attached to a web app under development."
        : "This prompt was sent from the aiui intent tool.",
    );
  }

  if (hasTab) {
    const record: TabRecord = {
      url: tab.url ?? "",
      ...(tab.title !== undefined ? { title: tab.title } : {}),
      ...(aiui ? { aiui: true } : {}),
      ...(tab.chromeTabId !== undefined ? { chromeTabId: tab.chromeTabId } : {}),
      ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
      ...(tab.tabIndex !== undefined ? { tabIndex: tab.tabIndex } : {}),
      ...(tab.targetId !== undefined ? { targetId: tab.targetId } : {}),
    };
    sections.push(`It was submitted from this browser tab:\n${renderTabRecord(record)}`);
  }

  if (aiui && source?.root !== undefined) {
    sections.push(`Relative paths in this prompt are relative to: ${source.root}`);
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
    attribution.push(
      `produced by cell ${selection.cell}${
        selection.cellLoc !== undefined ? ` defined at ${selection.cellLoc}` : ""
      }`,
    );
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
 * Wrap a user prompt in already-assembled context sections, also reporting the
 * length of the prepended preamble. `preambleLen` is the character offset the
 * body was shifted by (0 when no sections were added) — the intent lowering
 * uses it to prepend a `preamble` {@link PromptSpan} and shift the body spans,
 * so the trace hero can grey the preamble without string-splitting on the
 * `---` separator. The body is the join's last segment, so its offset is
 * exactly `result.length - text.length`.
 *
 * The bare `---` rule is the whole context/prompt divider (the "The user's
 * prompt follows." sentence was boilerplate — dropped in the render audit);
 * the opening line is {@link promptContextSections}'s, so it can be honest
 * about whether an aiui app is attached.
 */
export function wrapWithContextParts(
  sections: string[],
  text: string,
): { text: string; preambleLen: number } {
  if (sections.length === 0) {
    return { text, preambleLen: 0 };
  }
  const result = [...sections, "---", text].join("\n\n");
  return { text: result, preambleLen: result.length - text.length };
}

/**
 * Wrap a user prompt in already-assembled context sections. The one place the
 * enclosing wording lives — {@link augmentTextPrompt} and the `intent-v1`
 * lowering both feed it their sections so the two formats stay byte-identical.
 * No sections → the text is returned unchanged (a bare client still works).
 */
export function wrapWithContext(sections: string[], text: string): string {
  return wrapWithContextParts(sections, text).text;
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
