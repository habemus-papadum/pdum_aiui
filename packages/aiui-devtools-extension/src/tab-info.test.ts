import { describe, expect, it } from "vitest";
import { buildTabStamp, type DebugTargetLike, pageTargetIdFor } from "./tab-info";

const targets: DebugTargetLike[] = [
  { id: "WORKER1", type: "worker", tabId: 7 },
  { id: "PAGE7", type: "page", tabId: 7 },
  { id: "PAGE9", type: "page", tabId: 9 },
  { id: "OTHER", type: "other" },
];

describe("pageTargetIdFor", () => {
  it("finds the page target for a tab, ignoring workers and tabless targets", () => {
    expect(pageTargetIdFor(targets, 7)).toBe("PAGE7");
    expect(pageTargetIdFor(targets, 9)).toBe("PAGE9");
    expect(pageTargetIdFor(targets, 8)).toBeUndefined();
  });
});

describe("buildTabStamp", () => {
  it("assembles the full stamp when everything resolves", () => {
    expect(buildTabStamp({ id: 7, windowId: 2, index: 3 }, targets)).toEqual({
      chromeTabId: 7,
      windowId: 2,
      tabIndex: 3,
      targetId: "PAGE7",
    });
  });

  it("drops what it can't know — a partial stamp beats none", () => {
    expect(buildTabStamp({ id: 8 }, [])).toEqual({ chromeTabId: 8 });
  });
});
