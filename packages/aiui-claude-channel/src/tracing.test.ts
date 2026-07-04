import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelFormat, ThreadContext } from "./channel";
import { jsonCodec } from "./codec";
import { textConcatFormat } from "./processors";
import { createTraceStore, listTraces } from "./trace";
import { traceOf, withTracing } from "./tracing";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-tracing-"));

/** Drive a traced format's processor directly, as the channel would. */
function makeThread(format: ChannelFormat, sent: string[]) {
  let closed = false;
  const ctx: ThreadContext = {
    threadId: "t-1",
    sendPrompt: (text) => {
      sent.push(text);
    },
    close: () => {
      closed = true;
    },
  };
  const processor = format.createProcessor(ctx);
  return { processor, isClosed: () => closed };
}

describe("withTracing", () => {
  it("records inputs, the lowered prompt, and completion for text-concat", async () => {
    const cache = freshCache();
    const formats = withTracing(
      new Map([["text-concat", textConcatFormat]]),
      createTraceStore(cache),
    );
    const sent: string[] = [];
    const { processor, isClosed } = makeThread(formats.get("text-concat") as ChannelFormat, sent);

    await processor.onMessage({ text: "hello " }, { fin: false });
    await processor.onMessage({ text: "world" }, { fin: true });

    // The underlying processor still works untouched…
    expect(sent).toEqual(["hello world"]);
    expect(isClosed()).toBe(true);

    // …and the whole run was traced.
    const [trace] = listTraces(cache);
    expect(trace.format).toBe("text-concat");
    expect(trace.threadId).toBe("t-1");
    expect(trace.status).toBe("completed");
    expect(trace.stages.map((s) => [s.kind, s.label])).toEqual([
      ["input", "frame 0"],
      ["input", "frame 1 (fin)"],
      ["output", "lowered prompt"],
    ]);
    expect(trace.stages[2].data).toBe("hello world");
  });

  it("stores binary payloads as blob files, not inline JSON", async () => {
    const cache = freshCache();
    const rawFormat: ChannelFormat = {
      codec: { id: "raw", encode: (p) => p as Uint8Array, decode: (b) => b },
      createProcessor: (ctx) => ({
        onMessage(_payload, meta) {
          if (meta.fin) {
            ctx.close();
          }
        },
      }),
    };
    const formats = withTracing(new Map([["raw", rawFormat]]), createTraceStore(cache));
    const { processor } = makeThread(formats.get("raw") as ChannelFormat, []);

    await processor.onMessage(new Uint8Array([1, 2, 3]), { fin: true });

    const [trace] = listTraces(cache);
    expect(trace.stages[0].file).toBe("input-0.bin");
    expect(trace.stages[0].data).toBeUndefined();
  });

  it("lets a processor record intermediate representations via traceOf", async () => {
    const cache = freshCache();
    const irFormat: ChannelFormat = {
      codec: jsonCodec,
      createProcessor: (ctx) => ({
        async onMessage(payload, meta) {
          const upper = String((payload as { text: string }).text).toUpperCase();
          traceOf(ctx)?.record({ kind: "ir", label: "uppercased", data: upper });
          if (meta.fin) {
            await ctx.sendPrompt(upper);
            ctx.close();
          }
        },
      }),
    };
    const formats = withTracing(new Map([["ir", irFormat]]), createTraceStore(cache));
    const sent: string[] = [];
    const { processor } = makeThread(formats.get("ir") as ChannelFormat, sent);

    await processor.onMessage({ text: "shout" }, { fin: true });

    expect(sent).toEqual(["SHOUT"]);
    const [trace] = listTraces(cache);
    expect(trace.stages.map((s) => s.kind)).toEqual(["input", "ir", "output"]);
    expect(trace.stages[1].data).toBe("SHOUT");
  });

  it("traceOf returns undefined outside tracing", () => {
    expect(traceOf({ threadId: "x", sendPrompt: () => {}, close: () => {} })).toBeUndefined();
  });
});
