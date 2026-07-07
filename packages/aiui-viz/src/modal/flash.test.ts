// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIFF_CLASSES,
  isExtension,
  LIVE_FLASH_MS,
  LiveDiffText,
  renderRuns,
  runsFragment,
  SETTLE_FLASH_MS,
} from "./flash";

describe("the house tempo", () => {
  it("streams settle faster than discrete patches — the tail must not lag the stream", () => {
    expect(LIVE_FLASH_MS).toBeGreaterThan(0);
    expect(SETTLE_FLASH_MS).toBeGreaterThan(LIVE_FLASH_MS);
  });
});

describe("isExtension", () => {
  it("appended words are extensions; rewrites are revisions", () => {
    expect(isExtension("make the", "make the curve")).toBe(true);
    expect(isExtension("", "anything")).toBe(true);
    expect(isExtension("make the curb", "make the curve")).toBe(false);
    expect(isExtension("make the curve", "make the")).toBe(false); // shrank — a revision
  });
});

describe("runsFragment / renderRuns", () => {
  it("marks deletions and additions with the historical classes, leaves common words unstyled", () => {
    const host = document.createElement("div");
    host.append(runsFragment("make the curb thicker", "make the curve thicker"));
    const dels = [...host.querySelectorAll(".mm-diff-del")].map((el) => el.textContent?.trim());
    const adds = [...host.querySelectorAll(".mm-diff-add")].map((el) => el.textContent?.trim());
    expect(dels).toEqual(["curb"]);
    expect(adds).toEqual(["curve"]);
    expect(host.textContent).toContain("make the");
    // The defaults ARE the overlay's names — extraction changed nothing.
    expect(DEFAULT_DIFF_CLASSES).toEqual({ del: "mm-diff-del", add: "mm-diff-add" });
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

  it("a surface may restyle the runs via DiffRunClasses", () => {
    const host = document.createElement("div");
    host.append(runsFragment("old word", "new word", { del: "viz-del", add: "viz-add" }));
    expect(host.querySelector(".viz-del")?.textContent?.trim()).toBe("old");
    expect(host.querySelector(".viz-add")?.textContent?.trim()).toBe("new");
    expect(host.querySelector(".mm-diff-del")).toBeNull();
  });
});

describe("LiveDiffText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extensions render clean immediately — no strobe on ordinary streaming", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host);
    live.update("make the");
    live.update("make the curve");
    expect(host.textContent).toBe("make the curve");
    expect(host.querySelector(".mm-diff-add")).toBeNull();
    expect(vi.getTimerCount()).toBe(0); // nothing pending — extensions never arm the flash
  });

  it("revisions flash the word-diff, then settle to the clean text", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host, { flashMs: () => 20 });
    live.update("make the curb");
    live.update("make the curve"); // the model rewrote its hypothesis
    expect(host.querySelector(".mm-diff-del")?.textContent?.trim()).toBe("curb");
    expect(host.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("curve");
    vi.advanceTimersByTime(20);
    expect(host.textContent).toBe("make the curve");
    expect(host.querySelector(".mm-diff-del")).toBeNull();
    expect(live.value).toBe("make the curve");
  });

  it("defaults the settle delay to the house LIVE_FLASH_MS", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host);
    live.update("the curb");
    live.update("the curve");
    vi.advanceTimersByTime(LIVE_FLASH_MS - 1);
    expect(host.querySelector(".mm-diff-del")).not.toBeNull(); // still reading the diff
    vi.advanceTimersByTime(1);
    expect(host.textContent).toBe("the curve");
  });

  it("flashes with the caller's classes when the options say so", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host, {
      flashMs: () => 20,
      classes: { del: "viz-del", add: "viz-add" },
    });
    live.update("the curb");
    live.update("the curve");
    expect(host.querySelector(".viz-del")?.textContent?.trim()).toBe("curb");
    expect(host.querySelector(".mm-diff-del")).toBeNull();
  });

  it("a second revision mid-flash re-arms the timer — the stale settle never fires early", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host, { flashMs: () => 20 });
    live.update("alpha one");
    live.update("beta one"); // first revision, flash armed
    vi.advanceTimersByTime(10);
    live.update("gamma one"); // second revision, half-way through the first flash
    // The first timer's deadline passes; the SECOND flash must still be showing.
    vi.advanceTimersByTime(10);
    expect(host.querySelector(".mm-diff-del")?.textContent?.trim()).toBe("beta");
    expect(host.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("gamma");
    vi.advanceTimersByTime(10); // the re-armed timer's own 20ms elapse
    expect(host.textContent).toBe("gamma one");
  });

  it("a repeated identical update is a no-op (no re-render, no flash)", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host, { flashMs: () => 20 });
    live.update("steady text");
    live.update("steady text");
    expect(host.textContent).toBe("steady text");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clear() empties the line, forgets the text, and cancels a pending settle", () => {
    const host = document.createElement("div");
    const live = new LiveDiffText(host, { flashMs: () => 20 });
    live.update("the curb");
    live.update("the curve"); // flash in flight…
    live.clear(); // …surface closed mid-flash
    expect(host.textContent).toBe("");
    expect(live.value).toBe("");
    expect(vi.getTimerCount()).toBe(0); // the settle timer died with the segment
    live.update("fresh"); // a new segment starts clean, no phantom diff
    expect(host.querySelector(".mm-diff-add")).toBeNull();
    expect(host.textContent).toBe("fresh");
  });
});
