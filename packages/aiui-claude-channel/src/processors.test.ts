import { describe, expect, it } from "vitest";
import type { StreamProcessor, ThreadContext } from "./channel";
import { jsonCodec } from "./codec";
import type { HelloMeta } from "./frame";
import {
  augmentTextPrompt,
  defaultFormats,
  textConcatFormat,
  textConcatProcessor,
} from "./processors";

/** A text-concat processor wired to a recording context. */
const build = (
  hello?: HelloMeta,
): { processor: StreamProcessor; prompts: string[]; isClosed: () => boolean } => {
  const prompts: string[] = [];
  let closed = false;
  const ctx: ThreadContext = {
    threadId: "t1",
    ...(hello !== undefined ? { hello } : {}),
    sendPrompt: (text) => {
      prompts.push(text);
    },
    close: () => {
      closed = true;
    },
  };
  return { processor: textConcatProcessor(ctx), prompts, isClosed: () => closed };
};

const chunk = (text: string) => ({ text });
const notFin = { fin: false };
const fin = { fin: true };

describe("textConcatProcessor", () => {
  it("concatenates chunks and sends them as one prompt on fin", async () => {
    const { processor, prompts, isClosed } = build();
    await processor.onMessage(chunk("Hello, "), notFin);
    await processor.onMessage(chunk("world"), notFin);
    expect(prompts).toEqual([]);
    expect(isClosed()).toBe(false);

    await processor.onMessage(undefined, fin);
    expect(prompts).toEqual(["Hello, world"]);
    expect(isClosed()).toBe(true);
  });

  it("accepts a final chunk and fin on the same frame", async () => {
    const { processor, prompts, isClosed } = build();
    await processor.onMessage(chunk("one "), notFin);
    await processor.onMessage(chunk("shot"), fin);
    expect(prompts).toEqual(["one shot"]);
    expect(isClosed()).toBe(true);
  });

  it("closes without sending when nothing was accumulated", async () => {
    const { processor, prompts, isClosed } = build();
    await processor.onMessage(undefined, fin);
    expect(prompts).toEqual([]);
    expect(isClosed()).toBe(true);
  });

  it("rejects a malformed payload", async () => {
    const { processor, prompts, isClosed } = build();
    for (const payload of ["hi", 7, { text: 7 }]) {
      await expect(processor.onMessage(payload, notFin)).rejects.toThrow();
    }
    expect(prompts).toEqual([]);
    expect(isClosed()).toBe(false);
  });
});

describe("textConcatProcessor with hello context", () => {
  it("wraps the user text in the connection's tab + source context", async () => {
    const { processor, prompts } = build({
      tab: { url: "http://localhost:5199/", title: "spectra", chromeTabId: 7, windowId: 2 },
      source: { root: "/repo/packages/aiui-demo" },
    });
    await processor.onMessage(chunk("Make the plot wider"), fin);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    // The context preamble…
    expect(prompt).toContain('"spectra" at http://localhost:5199/');
    expect(prompt).toContain("chrome tab id 7");
    expect(prompt).toContain("window id 2");
    expect(prompt).toContain("list_pages");
    expect(prompt).toContain("session-browser skill");
    expect(prompt).toContain("/repo/packages/aiui-demo");
    // …then the user's text, verbatim and last.
    expect(prompt.endsWith("Make the plot wider")).toBe(true);
  });
});

describe("augmentTextPrompt", () => {
  it("returns the text unchanged with no context", () => {
    expect(augmentTextPrompt("hi", undefined)).toBe("hi");
    expect(augmentTextPrompt("hi", {})).toBe("hi");
    // A tab with neither url nor title is no context at all.
    expect(augmentTextPrompt("hi", { tab: {} })).toBe("hi");
  });

  it("includes only the sections it has data for", () => {
    const sourceOnly = augmentTextPrompt("hi", { source: { root: "/src/app" } });
    expect(sourceOnly).toContain("/src/app");
    expect(sourceOnly).not.toContain("browser tab");

    const tabOnly = augmentTextPrompt("hi", { tab: { url: "http://x/", title: "t" } });
    expect(tabOnly).toContain("http://x/");
    expect(tabOnly).not.toContain("located at");
  });

  it("omits the id hints when the extension stamped nothing", () => {
    const prompt = augmentTextPrompt("hi", { tab: { url: "http://x/", title: "t" } });
    expect(prompt).not.toContain("chrome tab id");
    expect(prompt).not.toContain("CDP target id");
  });

  it("includes the CDP target id and tab index when present", () => {
    const prompt = augmentTextPrompt("hi", {
      tab: { url: "http://x/", title: "t", tabIndex: 3, targetId: "ABC123" },
    });
    expect(prompt).toContain("tab index 3");
    expect(prompt).toContain("CDP target id ABC123");
  });
});

describe("defaultFormats", () => {
  it("registers text-concat with the JSON codec", () => {
    expect(defaultFormats().get("text-concat")).toBe(textConcatFormat);
    expect(textConcatFormat.codec).toBe(jsonCodec);
  });
});
