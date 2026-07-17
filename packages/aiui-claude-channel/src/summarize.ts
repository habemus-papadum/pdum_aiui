/**
 * The turn-summary seam: a one-line gloss of a lowered prompt, for the trace list.
 *
 * A busy session piles up dozens of traces, and a row that reads only
 * "18:52 · intent-v1" tells you nothing about *which* turn it was. So after a
 * turn is sent, the channel asks a cheap chat model to compress the composed
 * body into a ≤ 12-word line and writes it back onto the manifest (see
 * {@link TraceHandle.setSummary}) — the list route serves manifests, so the
 * gloss rides to every viewer for free and the debug-viewer/DevTools rows can title
 * themselves "18:52 · rewrite the beet essay to say vite".
 *
 * This is deliberately **best-effort and off the hot path**: the fin commit
 * fires it and does not await it (a summary must never delay the send ack), a
 * keyless channel (no seam) skips it silently, and any failure is swallowed.
 * The seam mirrors {@link Corrector}/{@link Transcriber}: a `summarizer` test
 * override in {@link IntentV1Options} stands in for the real REST call offline.
 */
import { type CallCost, priceCall, usageFromChatCompletions } from "./cost";
import type { FetchLike } from "./transcribe";

/** A produced summary: the one-liner plus what the call cost (when known). */
export interface SummaryResult {
  text: string;
  cost?: CallCost;
}

/** Turns a lowered-prompt body into a one-line summary. */
export interface Summarizer {
  readonly name: string;
  /** Summarize the composed body; throws on any transport/model failure. */
  summarize(body: string): Promise<SummaryResult>;
}

/**
 * Prepare the composed body for the summarizer's user turn: screenshots carry no
 * signal for a one-line gloss (and their metadata blocks would blow the budget),
 * so drop each `<screenshot-metadata …>` block and collapse each
 * `[screenshot located at …]` / `[pasted image located at …]` bracket line to
 * the literal `[screenshot]`, then cap at 1000 chars — a summary of the opening
 * is as good as a summary of the whole, and the model call stays cheap. Pure and
 * exported so the transform is unit-tested independently of the network seam.
 */
export function summaryPromptInput(body: string): string {
  const withoutShots = body
    .replace(/<screenshot-metadata[^>]*(?:\/>|>[\s\S]*?<\/screenshot-metadata>)\n?/g, "")
    .replace(/\[(?:screenshot|pasted image)[^\]]*\]/g, "[screenshot]");
  return withoutShots.slice(0, 1000);
}

/** The instruction the summarizer runs under — kept terse, the row has no room. */
export const SUMMARY_SYSTEM_PROMPT =
  "Summarize this request to a coding agent in one line, ≤ 12 words, no quotes.";

/** The default summary model — small, fast, and cheap; this is a convenience gloss. */
export const DEFAULT_SUMMARY_MODEL = "gpt-4o-mini";

export interface OpenAiSummarizerOptions {
  /** The OpenAI API key. */
  apiKey: string;
  /** Resolves the chat model at call time (default `gpt-4o-mini`). */
  model?: () => string;
  /** Injected fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Override the endpoint (tests). */
  baseUrl?: string;
}

/**
 * The real summarizer: one chat-completions call against OpenAI, temperature 0.
 * Structurally a shrunk {@link openaiCorrector} — same endpoint, same key, same
 * failure shape (throw so the caller can swallow) — because the summary is a
 * throwaway nicety and does not deserve its own transport.
 */
export function openaiSummarizer(options: OpenAiSummarizerOptions): Summarizer {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.openai.com";
  const model = options.model ?? (() => DEFAULT_SUMMARY_MODEL);
  return {
    name: "openai",
    async summarize(body) {
      const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: model(),
          temperature: 0,
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: summaryPromptInput(body) },
          ],
        }),
      });
      const payload = (await res.json()) as {
        error?: { message?: string };
        usage?: unknown;
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!res.ok || payload.error || !content) {
        throw new Error(payload.error?.message ?? `summary failed (${res.status})`);
      }
      const usage = usageFromChatCompletions(payload.usage);
      // Models occasionally wrap a one-liner in quotes despite the instruction;
      // strip a single enclosing pair so the row title stays clean.
      const text = content
        .trim()
        .replace(/^["“](.*)["”]$/s, "$1")
        .trim();
      return { text, ...(usage ? { cost: priceCall("openai", model(), usage) } : {}) };
    },
  };
}
