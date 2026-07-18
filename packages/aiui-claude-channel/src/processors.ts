/**
 * Built-in stream formats.
 *
 * A format pairs a {@link PayloadCodec} (how its payload bytes decode) with a
 * {@link StreamProcessorFactory} (what to do with the decoded payloads); the
 * processor consumes one thread's messages and decides when the thread is done
 * (see channel.ts for the protocol). The registry built by
 * {@link defaultFormats} is what the web backend speaks unless the caller hands
 * {@link startWebServer} its own.
 *
 * `text-concat` is the protocol's REFERENCE/DIAGNOSTIC format, not a peer
 * modality: the production client speaks `intent-v1`; text-concat is what
 * `quick --ws`, the e2e suite, and the transport tests dial because it
 * exercises the whole /ws lifecycle (hello, threads, fin, acks, reload
 * cycling) without the lowering pipeline behind it.
 */

import type { ChannelFormat, StreamProcessorFactory } from "./channel";
import { jsonCodec } from "./codec";
import { intentV1Format } from "./intent-v1";
import { augmentTextPrompt } from "./prompt-context";
import { traceOf } from "./tracing";

// The connection-context preamble is shared with the `intent-v1` lowering, so
// it lives in prompt-context.ts; re-exported here for the package's public API.
export { augmentTextPrompt } from "./prompt-context";

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
 * The `text-concat` format (JSON payloads): each `data` frame carries an
 * optional `{ "text": string }` chunk, concatenated verbatim (no separator)
 * until a frame marked `fin`, which sends the accumulated text — wrapped in
 * the connection's tab/source context (see {@link augmentTextPrompt}) — into
 * the session as a single prompt and closes the thread. The final chunk and
 * `fin` may ride the same frame. A thread finished with nothing accumulated
 * closes without sending anything.
 */
const textConcatProcessor: StreamProcessorFactory = (ctx) => {
  const parts: string[] = [];
  return {
    async onMessage(payload: unknown, meta) {
      const text = asTextChunk(payload);
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

/** The built-in `text-concat` format (the /ws reference format). */
export const textConcatFormat: ChannelFormat = {
  codec: jsonCodec,
  createProcessor: textConcatProcessor,
};

/** The built-in format registry: stream format name → format. */
export function defaultFormats(): Map<string, ChannelFormat> {
  return new Map([
    ["text-concat", textConcatFormat],
    ["intent-v1", intentV1Format],
  ]);
}
