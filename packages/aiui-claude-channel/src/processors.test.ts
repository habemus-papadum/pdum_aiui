import { describe, expect, it } from "vitest";
import type { StreamProcessor, ThreadContext } from "./channel";
import { defaultProcessors, textConcatProcessor } from "./processors";

/** A text-concat processor wired to a recording context. */
const build = (): { processor: StreamProcessor; prompts: string[]; isClosed: () => boolean } => {
  const prompts: string[] = [];
  let closed = false;
  const ctx: ThreadContext = {
    threadId: "t1",
    sendPrompt: (text) => {
      prompts.push(text);
    },
    close: () => {
      closed = true;
    },
  };
  return { processor: textConcatProcessor(ctx), prompts, isClosed: () => closed };
};

describe("textConcatProcessor", () => {
  it("concatenates chunks and sends them as one prompt on done", async () => {
    const { processor, prompts, isClosed } = build();
    await processor.onMessage({ text: "Hello, " });
    await processor.onMessage({ text: "world" });
    expect(prompts).toEqual([]);
    expect(isClosed()).toBe(false);

    await processor.onMessage({ done: true });
    expect(prompts).toEqual(["Hello, world"]);
    expect(isClosed()).toBe(true);
  });

  it("accepts a final chunk and done in the same payload", async () => {
    const { processor, prompts, isClosed } = build();
    await processor.onMessage({ text: "one " });
    await processor.onMessage({ text: "shot", done: true });
    expect(prompts).toEqual(["one shot"]);
    expect(isClosed()).toBe(true);
  });

  it("closes without sending when nothing was accumulated", async () => {
    const { processor, prompts, isClosed } = build();
    await processor.onMessage({ done: true });
    expect(prompts).toEqual([]);
    expect(isClosed()).toBe(true);
  });

  it("rejects malformed payloads", async () => {
    const { processor, prompts, isClosed } = build();
    for (const payload of [undefined, null, "hi", { text: 7 }, { done: "yes" }, {}]) {
      await expect(processor.onMessage(payload)).rejects.toThrow();
    }
    expect(prompts).toEqual([]);
    expect(isClosed()).toBe(false);
  });
});

describe("defaultProcessors", () => {
  it("registers text-concat", () => {
    expect(defaultProcessors().get("text-concat")).toBe(textConcatProcessor);
  });
});
