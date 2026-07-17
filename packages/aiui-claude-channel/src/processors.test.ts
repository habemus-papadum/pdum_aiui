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
    // The context preamble: the honest opening (a source root means an aiui
    // app), the canonical <tab> record, and the relative-paths line — the
    // correlation LESSON lives in the MCP server instructions, not per turn.
    expect(prompt).toContain("attached to a web app under development");
    expect(prompt).toContain(
      '<tab url="http://localhost:5199/" title="spectra" aiui-app="true" ' +
        'chrome-tab-id="7" window-id="2"/>',
    );
    expect(prompt).toContain(
      "Relative paths in this prompt are relative to: /repo/packages/aiui-demo",
    );
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

describe("augmentTextPrompt with an on-screen selection", () => {
  it("adds a selection block with attribution and TeX", () => {
    const prompt = augmentTextPrompt("make this wider", undefined, {
      text: "reaction-diffusion on the GPU",
      sourceLoc: "src/ui/App.tsx:32:9",
      cell: "catalog",
      tex: "\\partial u/\\partial t",
    });
    expect(prompt).toContain(
      'It concerns this on-screen selection: "reaction-diffusion on the GPU"',
    );
    expect(prompt).toContain("authored at src/ui/App.tsx:32:9");
    expect(prompt).toContain("produced by cell catalog");
    expect(prompt).toContain("its TeX source: \\partial u/\\partial t");
    expect(prompt.endsWith("make this wider")).toBe(true);
  });

  it("includes only the selected text when there is no attribution", () => {
    const prompt = augmentTextPrompt("hi", undefined, { text: "some words" });
    expect(prompt).toContain('It concerns this on-screen selection: "some words".');
    expect(prompt).not.toContain("authored at");
    expect(prompt).not.toContain("produced by cell");
    expect(prompt).not.toContain("TeX source");
  });

  it("leaves the prompt unchanged when the selection carries no text", () => {
    expect(augmentTextPrompt("hi", undefined, undefined)).toBe("hi");
    expect(augmentTextPrompt("hi", undefined, {})).toBe("hi");
  });

  it("composes after the tab/source block and before the user's prompt", () => {
    const prompt = augmentTextPrompt(
      "make it bigger",
      {
        tab: { url: "http://localhost:5199/", title: "morphogen" },
        source: { root: "/repo/app" },
      },
      { text: "the header", sourceLoc: "src/ui/App.tsx:10:3" },
    );
    const srcIdx = prompt.indexOf("/repo/app");
    const selIdx = prompt.indexOf("on-screen selection");
    const promptIdx = prompt.indexOf("\n\n---\n\nmake it bigger");
    expect(srcIdx).toBeGreaterThan(-1);
    expect(selIdx).toBeGreaterThan(srcIdx);
    expect(promptIdx).toBeGreaterThan(selIdx);
    expect(prompt.endsWith("make it bigger")).toBe(true);
  });
});

describe("textConcatProcessor with a selection", () => {
  it("augments the prompt with a selection carried on a frame", async () => {
    const { processor, prompts } = build();
    await processor.onMessage(
      { text: "make this wider", selection: { text: "the plot", sourceLoc: "src/ui/App.tsx:5:1" } },
      fin,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('on-screen selection: "the plot"');
    expect(prompts[0]).toContain("authored at src/ui/App.tsx:5:1");
    expect(prompts[0].endsWith("make this wider")).toBe(true);
  });

  it("keeps the last selection seen across frames", async () => {
    const { processor, prompts } = build();
    await processor.onMessage({ text: "a ", selection: { text: "first" } }, notFin);
    await processor.onMessage({ text: "b", selection: { text: "second" } }, fin);
    expect(prompts[0]).toContain('on-screen selection: "second"');
    expect(prompts[0]).not.toContain("first");
  });

  it("ignores a malformed selection but still sends the text", async () => {
    const { processor, prompts } = build();
    await processor.onMessage({ text: "hello", selection: "nonsense" }, fin);
    expect(prompts).toEqual(["hello"]);
  });

  it("sends an identical prompt to the no-selection case when none is present", async () => {
    const withArg = build();
    await withArg.processor.onMessage({ text: "just text" }, fin);
    const withoutSelectionField = build();
    await withoutSelectionField.processor.onMessage({ text: "just text", selection: {} }, fin);
    expect(withArg.prompts[0]).toBe("just text");
    expect(withoutSelectionField.prompts[0]).toBe("just text");
  });
});

describe("defaultFormats", () => {
  it("registers text-concat with the JSON codec", () => {
    expect(defaultFormats().get("text-concat")).toBe(textConcatFormat);
    expect(textConcatFormat.codec).toBe(jsonCodec);
  });
});
