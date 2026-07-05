/**
 * Tracing as a format-registry decorator.
 *
 * {@link withTracing} wraps every {@link ChannelFormat} in a registry so each
 * new thread records a lowering trace (see trace.ts) — the decoded inputs as
 * they arrive, the final lowered prompt as it's sent, and the thread's end —
 * without the formats themselves knowing tracing exists. Processors stay pure;
 * the decorator observes at the boundaries (payload in, `sendPrompt` out,
 * `close`).
 *
 * Processors that *want* to expose their intermediate representations (a
 * transcript from an audio pass, a helper-LLM's draft, a resolved-pronoun
 * rewrite) can opt in: the {@link ThreadContext} they receive is actually a
 * {@link TracingThreadContext}, and {@link traceOf} recovers the handle:
 *
 * ```ts
 * const trace = traceOf(ctx);
 * trace?.record({ kind: "ir", label: "resolved pronouns", data: rewritten });
 * ```
 */
import type { ChannelFormat, FormatRegistry, ThreadContext } from "./channel";
import type { TraceHandle, TraceStore } from "./trace";

/** The extended context tracing hands to processors (structurally compatible). */
export interface TracingThreadContext extends ThreadContext {
  /** The live trace for this thread — record `ir`/`info` stages on it. */
  trace: TraceHandle;
}

/** Recover the trace handle from a thread context, if tracing is active. */
export function traceOf(ctx: ThreadContext): TraceHandle | undefined {
  return (ctx as Partial<TracingThreadContext>).trace;
}

/** Cap for inline `input` stage data; larger payloads land as blob files. */
const INLINE_LIMIT = 64 * 1024;

/** Wrap one format so each of its threads records a trace. */
function traceFormat(name: string, format: ChannelFormat, store: TraceStore): ChannelFormat {
  return {
    codec: format.codec,
    createProcessor: (ctx) => {
      const trace = store.begin(name, ctx.threadId);
      // The connection's client context (tab identity, source location) shapes
      // the lowering — make it visible on every trace, whatever the format.
      if (ctx.hello !== undefined) {
        trace.record({ kind: "info", label: "client context", data: ctx.hello });
      }

      const tracedCtx: TracingThreadContext = {
        threadId: ctx.threadId,
        ...(ctx.hello !== undefined ? { hello: ctx.hello } : {}),
        ...(ctx.push !== undefined ? { push: ctx.push } : {}),
        trace,
        sendPrompt: async (text, meta) => {
          trace.record({
            kind: "output",
            label: "lowered prompt",
            data: meta !== undefined ? { text, meta } : text,
          });
          await ctx.sendPrompt(text, meta);
        },
        close: () => {
          trace.end("completed");
          ctx.close();
        },
      };

      const inner = format.createProcessor(tracedCtx);
      let frame = 0;
      return {
        onMessage(payload, meta) {
          // Name the input stage after its chunk (intent-v1) so the /debug
          // viewer reads "frame 3 attachment shot_1" rather than a bare index.
          const chunk = meta.chunk
            ? ` ${meta.chunk.kind}${meta.chunk.kind === "attachment" ? ` ${meta.chunk.id}` : ""}`
            : "";
          const label = `frame ${frame}${chunk}${meta.fin ? " (fin)" : ""}`;
          if (payload instanceof Uint8Array) {
            // Binary payloads (screenshots, audio) go straight to a blob file.
            trace.recordBlob({ kind: "input", label }, payload, `input-${frame}.bin`);
          } else {
            const json = JSON.stringify(payload);
            if (json !== undefined && json.length > INLINE_LIMIT) {
              trace.recordBlob(
                { kind: "input", label },
                new TextEncoder().encode(json),
                `input-${frame}.json`,
              );
            } else {
              trace.record({ kind: "input", label, data: payload });
            }
          }
          frame += 1;
          return inner.onMessage(payload, meta);
        },
      };
    },
  };
}

/**
 * Decorate a format registry so every thread of every format records a
 * lowering trace into `store`. The returned registry is a new map; the input
 * formats are untouched.
 */
export function withTracing(formats: FormatRegistry, store: TraceStore): FormatRegistry {
  const traced = new Map<string, ChannelFormat>();
  for (const [name, format] of formats) {
    traced.set(name, traceFormat(name, format, store));
  }
  return traced;
}
