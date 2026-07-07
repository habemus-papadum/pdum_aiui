// @vitest-environment node
// (This package's default test environment is jsdom — vite-plugin-solid sets
// it when a config doesn't — so the node realm is opted into explicitly here.)
import { describe, expect, it } from "vitest";
import { createFocusTracker } from "./focus";

describe("createFocusTracker", () => {
  it("answers with the last deliberate focus, starting from the initial", () => {
    const tracker = createFocusTracker<"editor" | "gutter">("editor");
    expect(tracker.last()).toBe("editor");
    tracker.set("gutter");
    expect(tracker.last()).toBe("gutter");
    tracker.set("editor");
    expect(tracker.last()).toBe("editor");
  });

  it("is plain state, no DOM: this file runs in node, where document.activeElement cannot lie", () => {
    // The whole point of the tracker is that decision code never asks the DOM
    // where focus is — so the tracker must work where there is no DOM at all.
    expect(typeof document).toBe("undefined");
    const tracker = createFocusTracker("text");
    tracker.set("text"); // re-recording the same place is fine
    expect(tracker.last()).toBe("text");
  });

  it("keeps each tracker's state independent", () => {
    const a = createFocusTracker<"x" | "y">("x");
    const b = createFocusTracker<"x" | "y">("x");
    a.set("y");
    expect(a.last()).toBe("y");
    expect(b.last()).toBe("x");
  });
});
