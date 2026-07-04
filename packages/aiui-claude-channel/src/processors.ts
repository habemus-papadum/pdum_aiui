/**
 * Built-in stream formats.
 *
 * A format pairs a {@link PayloadCodec} (how its payload bytes decode) with a
 * {@link StreamProcessorFactory} (what to do with the decoded payloads); the
 * processor consumes one thread's messages and decides when the thread is done
 * (see channel.ts for the protocol). The registry built by
 * {@link defaultFormats} is what the web backend speaks unless the caller hands
 * {@link startWebServer} its own.
 */

import type { ChannelFormat, StreamProcessorFactory } from "./channel";
import { jsonCodec } from "./codec";
import type { HelloMeta } from "./frame";
import { traceOf } from "./tracing";

/** The message payload a `text-concat` thread accepts: an optional text chunk. */
interface TextConcatPayload {
  /** A chunk to append to the thread's accumulated text. */
  text?: string;
}

/** Validate/narrow a decoded `text-concat` payload (may be empty on a bare fin). */
const asTextChunk = (payload: unknown): string | undefined => {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (typeof payload !== "object") {
    throw new Error('expected a payload like { "text": string }');
  }
  const { text } = payload as Record<string, unknown>;
  if (text !== undefined && typeof text !== "string") {
    throw new Error('"text" must be a string');
  }
  return text;
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
export function augmentTextPrompt(text: string, meta: HelloMeta | undefined): string {
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
 * The `text-concat` format (JSON payloads): each `data` frame carries an
 * optional `{ "text": string }` chunk, concatenated verbatim (no separator)
 * until a frame marked `fin`, which sends the accumulated text — wrapped in
 * the connection's tab/source context (see {@link augmentTextPrompt}) — into
 * the session as a single prompt and closes the thread. The final chunk and
 * `fin` may ride the same frame. A thread finished with nothing accumulated
 * closes without sending anything.
 */
export const textConcatProcessor: StreamProcessorFactory = (ctx) => {
  const parts: string[] = [];
  return {
    async onMessage(payload: unknown, meta) {
      const text = asTextChunk(payload as TextConcatPayload);
      if (text !== undefined) {
        parts.push(text);
      }
      if (meta.fin) {
        const userText = parts.join("");
        if (userText !== "") {
          const prompt = augmentTextPrompt(userText, ctx.hello);
          if (prompt !== userText) {
            // Expose the augmentation as a pipeline stage: user text in,
            // context-wrapped prompt out (the trace's `output` stage).
            traceOf(ctx)?.record({ kind: "ir", label: "user text", data: userText });
          }
          await ctx.sendPrompt(prompt);
        }
        ctx.close();
      }
    },
  };
};

/** The built-in `text-concat` format. */
export const textConcatFormat: ChannelFormat = {
  codec: jsonCodec,
  createProcessor: textConcatProcessor,
};

/** The built-in format registry: stream format name → format. */
export function defaultFormats(): Map<string, ChannelFormat> {
  return new Map([["text-concat", textConcatFormat]]);
}
