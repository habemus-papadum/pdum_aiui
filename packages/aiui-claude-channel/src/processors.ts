/**
 * Built-in stream processors.
 *
 * A processor consumes one thread's message payloads and decides when the
 * thread is done (see channel.ts for the protocol). The registry built by
 * {@link defaultProcessors} is what the web backend speaks unless the caller
 * hands {@link startWebServer} its own.
 */
import type { StreamProcessorFactory } from "./channel";

/** What a `text-concat` thread accepts as its message payloads. */
interface TextConcatPayload {
  /** A chunk to append to the thread's accumulated text. */
  text?: string;
  /** True to flush the accumulated text as one prompt and close the thread. */
  done?: boolean;
}

const asTextConcatPayload = (payload: unknown): TextConcatPayload => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error('expected a payload like { "text": string } or { "done": true }');
  }
  const { text, done } = payload as Record<string, unknown>;
  if (text !== undefined && typeof text !== "string") {
    throw new Error('"text" must be a string');
  }
  if (done !== undefined && typeof done !== "boolean") {
    throw new Error('"done" must be a boolean');
  }
  if (text === undefined && done === undefined) {
    throw new Error('expected a payload with "text" and/or "done"');
  }
  return { text, done };
};

/**
 * The `text-concat` format: payloads carry `text` chunks that are concatenated
 * (verbatim, no separator) until one arrives with `done: true`, which sends
 * the accumulated text into the session as a single prompt and closes the
 * thread. A payload may carry both — append the final chunk and finish. A
 * thread finished with nothing accumulated closes without sending anything.
 */
export const textConcatProcessor: StreamProcessorFactory = (ctx) => {
  const parts: string[] = [];
  return {
    async onMessage(payload) {
      const { text, done } = asTextConcatPayload(payload);
      if (text !== undefined) {
        parts.push(text);
      }
      if (done) {
        const prompt = parts.join("");
        if (prompt !== "") {
          await ctx.sendPrompt(prompt);
        }
        ctx.close();
      }
    },
  };
};

/** The built-in processor registry: stream format name → factory. */
export function defaultProcessors(): Map<string, StreamProcessorFactory> {
  return new Map([["text-concat", textConcatProcessor]]);
}
