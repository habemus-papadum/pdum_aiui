// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isExtension, LiveDiffText, renderRuns, runsFragment } from "./diff-flash";

describe("isExtension", () => {
  it("appended words are extensions; rewrites are revisions", () => {
    expect(isExtension("make the", "make the curve")).toBe(true);
    expect(isExtension("", "anything")).toBe(true);
    expect(isExtension("make the curb", "make the curve")).toBe(false);
    expect(isExtension("make the curve", "make the")).toBe(false); // shrank — a revision
  });
});

describe("runsFragment / renderRuns", () => {
  it("marks deletions and additions, leaves common words unstyled", () => {
    const host = document.createElement("div");
    host.append(runsFragment("make the curb thicker", "make the curve thicker"));
    const dels = [...host.querySelectorAll(".mm-diff-del")].map((el) => el.textContent?.trim());
    const adds = [...host.querySelectorAll(".mm-diff-add")].map((el) => el.textContent?.trim());
    expect(dels).toEqual(["curb"]);
    expect(adds).toEqual(["curve"]);
    expect(host.textContent).toContain("make the");
  });

  it("renderRuns renders precomputed runs identically (the preview's path)", () => {
    const host = document.createElement("div");
    host.append(
      renderRuns([
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
      ]),
    );
    expect(host.querySelector(".mm-diff-del")?.textContent?.trim()).toBe("old");
    expect(host.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("new");
  });
});

describe("LiveDiffText", () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("extensions render clean immediately — no strobe on ordinary streaming", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host);
    live.update("make the");
    live.update("make the curve");
    expect(host.textContent).toBe("make the curve");
    expect(host.querySelector(".mm-diff-add")).toBeNull();
  });

  it("revisions flash the word-diff, then settle to the clean text", async () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host, { flashMs: () => 20 });
    live.update("make the curb");
    live.update("make the curve"); // the model rewrote its hypothesis
    expect(host.querySelector(".mm-diff-del")?.textContent?.trim()).toBe("curb");
    expect(host.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("curve");
    await tick(40);
    expect(host.textContent).toBe("make the curve");
    expect(host.querySelector(".mm-diff-del")).toBeNull();
    expect(live.value).toBe("make the curve");
  });

  it("clear() empties the line and forgets the text", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host);
    live.update("something");
    live.clear();
    expect(host.textContent).toBe("");
    expect(live.value).toBe("");
    live.update("fresh"); // a new segment starts clean, no phantom diff
    expect(host.querySelector(".mm-diff-add")).toBeNull();
  });
});
