import { describe, expect, it } from "vitest";
import type { StreamProcessor, ThreadContext } from "./channel";
import { jsonCodec } from "./codec";
import type { HelloMeta } from "./frame";
import { augmentTextPrompt, defaultFormats, textConcatFormat } from "./processors";

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
  return { processor: textConcatFormat.createProcessor(ctx), prompts, isClosed: () => closed };
};

const chunk = (text: string) => ({ text });
const notFin = { fin: false };
const fin = { fin: true };

describe("text-concat processor", () => {
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

  it("tolerates (and ignores) the retired per-frame selection field", async () => {
    // Old senders rode `{ selection }` on a frame; the submit-time selection
    // path is retired (selections are positional intent-v1 events now), but a
    // stray field must not reject the frame.
    const { processor, prompts } = build();
    await processor.onMessage({ text: "hello", selection: { text: "the plot" } }, fin);
    expect(prompts).toEqual(["hello"]);
  });
});

describe("text-concat processor with hello context", () => {
  it("wraps the user text in the connection's tab + source context", async () => {
    const { processor, prompts } = build({
      tab: { url: "http://localhost:5199/", title: "spectra", chromeTabId: 7, windowId: 2 },
      source: { root: "/repo/demos/gallery" },
    });
    await processor.onMessage(chunk("Make the plot wider"), fin);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    // The context preamble: the honest opening (a source root means an aiui
    // app), the canonical <tab> record, and the relative-paths line — the
    // correlation LESSON lives in the MCP server instructions, not per turn.
    expect(prompt).toContain("attached to a web app under development");
    expect(prompt).toContain(
      '<tab url="http://localhost:5199/" title="spectra" aiui-app="true" ' +
        'chrome-tab-id="7" window-id="2"/>',
    );
    expect(prompt).toContain("Relative paths in this prompt are relative to: /repo/demos/gallery");
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
    expect(prompt).toContain('tab-index="3"');
    expect(prompt).toContain('cdp-target-id="ABC123"');
  });
});

describe("defaultFormats", () => {
  it("registers text-concat with the JSON codec", () => {
    expect(defaultFormats().get("text-concat")).toBe(textConcatFormat);
    expect(textConcatFormat.codec).toBe(jsonCodec);
  });
});
