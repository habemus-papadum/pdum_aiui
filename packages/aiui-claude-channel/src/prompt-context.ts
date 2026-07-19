/**
 * Shared prompt-context assembly: the connection-context preamble every format
 * wraps a user prompt in.
 *
 * Extracted from `text-concat` so the `intent-v1` lowering reuses the exact
 * same tab/source blocks instead of duplicating them — the two formats must
 * produce identical context wording so a trace reads the same whichever
 * modality lowered it. The wording lives in exactly one place —
 * {@link promptContextSections} builds the blocks and {@link wrapWithContext}
 * encloses them — which lets a streaming processor pre-warm the hello-fixed
 * part (tab/source) and defer only the body to `fin`, while `text-concat`
 * still calls the all-in-one {@link augmentTextPrompt}. (Selections never
 * pass through here: they ride the intent-v1 stream as positional
 * `app-selection`/`code-selection` events that `composeIntent` renders inline
 * in the body.)
 */
import { renderTabRecord, type TabRecord } from "@habemus-papadum/aiui-lowering-pipeline";
import type { CdpAlignmentInfo, HelloMeta } from "./frame";

/**
 * The note appended to the preamble when the turn contains SPEECH-transcribed
 * text (the intent lowering adds it; typed contributions never trigger it).
 * Exported so the section list and its tests share one string.
 */
export const TRANSCRIPTION_NOTE =
  "Portions of the prompt were transcribed and might have transcription errors.";

/**
 * The CDP-alignment notes (hello `meta.cdp` — the client's verdict on
 * whether ITS browser is the one this channel drives; intent client
 * `cdp-align.ts`). One sentence, agent-addressed: affirm alignment so the
 * agent uses its Chrome DevTools MCP without fear, or warn that DevTools
 * reads will NOT match what the user sees. Exported so the tests and the
 * section builder share one string.
 */
export const CDP_ALIGNED_NOTE =
  "Browser tooling: the Chrome DevTools MCP attached to this session sees the SAME browser " +
  "the user is viewing — its page list, screenshots, and evaluations reflect what they see.";
export const CDP_MISALIGNED_NOTE =
  "Browser tooling WARNING: the Chrome DevTools MCP attached to this session points at a " +
  "DIFFERENT browser than the one the user is viewing — page state read through it will NOT " +
  "match what they see. Trust the shots and selections in this prompt instead.";
export const CDP_NO_BROWSER_NOTE =
  "Browser tooling: this session drives no browser over CDP — rely on the shots and " +
  "selections in this prompt rather than browser-devtools tools.";

/** The co-driving heads-up appended to the aligned note when other channels
 * share the browser (a supported multi-agent workflow — each session should
 * keep to its own tabs, but honesty beats surprise). */
export function cdpSharedNote(coDrivers: Array<{ port?: number; label?: string }>): string {
  const names = coDrivers
    .map((d) => d.label ?? (d.port !== undefined ? `:${d.port}` : "unknown"))
    .join(", ");
  const plural = coDrivers.length === 1 ? "channel is" : "channels are";
  return (
    `Be aware: ${coDrivers.length} other aiui ${plural} driving this same browser (${names}). ` +
    "Each session should keep to its own tabs, but tabs you did not open may change " +
    "underneath you — do not assume every tab belongs to this session."
  );
}

/** The alignment sentence for a hello's `meta.cdp` (undefined = say nothing —
 * an older client, or an unknown verdict, must not produce false comfort). */
export function cdpAlignmentNote(cdp: CdpAlignmentInfo | undefined): string | undefined {
  const coDrivers = cdp?.coDrivers ?? [];
  switch (cdp?.state) {
    case "aligned":
      return coDrivers.length > 0
        ? `${CDP_ALIGNED_NOTE} ${cdpSharedNote(coDrivers)}`
        : CDP_ALIGNED_NOTE;
    case "driven-by-other": {
      const names = coDrivers
        .map((d) => d.label ?? (d.port !== undefined ? `:${d.port}` : "unknown"))
        .join(", ");
      return `${CDP_MISALIGNED_NOTE}${
        names !== "" ? ` (The user's browser is driven by: ${names}.)` : ""
      }`;
    }
    case "channel-drives-other":
      return CDP_MISALIGNED_NOTE;
    case "channel-no-cdp":
      return CDP_NO_BROWSER_NOTE;
    default:
      return undefined;
  }
}

/**
 * The tab + source context sections — everything the hello fixes at connect
 * time. Split out from {@link augmentTextPrompt} so a processor can
 * **pre-warm** this skeleton once at thread-open and only concatenate the
 * body + turn-dependent sections at `fin` (the incremental-lowering seam; see
 * archive/streaming-turns.md §2). Empty for a bare client with no tab/source context.
 *
 * Honesty rules (2026-07-17 render audit):
 * - "web app under development" and the relative-paths line appear only when
 *   an aiui app was DETECTED — interim signal: the hello carried a source
 *   root (the vite plugin stamps it). The side panel sits on arbitrary
 *   pages; those get the neutral opening line.
 * - The tab renders as a `[current tab: <tab …/>]` marker — the same
 *   canonical `<tab …/>` record ({@link renderTabRecord}) the boundary markers
 *   (`[current page/tab changed: …]`) and selection metadata carry, so the
 *   agent learns ONE way to read "the current tab is X". The MCP server's
 *   instructions teach the element once (ids are correlation hints; match via
 *   `list_pages` by url/title), so the per-turn preamble carries data, not
 *   lessons.
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
    sections.push(`[current tab: ${renderTabRecord(record)}]`);
  }

  if (aiui && source?.root !== undefined) {
    sections.push(`Relative paths in this prompt are relative to: ${source.root}`);
  }

  // The CDP-alignment sentence (hello-fixed, like everything here): warn or
  // affirm the agent about its DevTools MCP. Unknown/absent stays silent.
  const cdpNote = cdpAlignmentNote(meta?.cdp);
  if (cdpNote !== undefined) {
    sections.push(cdpNote);
  }

  return sections;
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
 * browser tab it came from (with the routing caveats an agent needs) and where
 * the page's source code lives. Returns the text unchanged when there is no
 * context to add — a bare client (no plugin, no extension) still works.
 */
export function augmentTextPrompt(text: string, meta: HelloMeta | undefined): string {
  return wrapWithContext(promptContextSections(meta), text);
}
