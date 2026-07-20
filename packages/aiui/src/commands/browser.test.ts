import { describe, expect, it } from "vitest";
import { startRefusal } from "./browser";

describe("startRefusal (the start half of `aiui open`'s decision)", () => {
  it("lets a plain open start the browser", () => {
    expect(startRefusal({ kind: "open" }, "http://x")).toBeUndefined();
  });

  it("refuses when the project opted out (chrome.enabled: false)", () => {
    const refusal = startRefusal({ kind: "skip" }, "http://x");
    expect(refusal?.title).toContain("chrome.enabled");
    expect(refusal?.detail).toContain("http://x");
  });

  it("hints instead of launching in a headless/CI environment", () => {
    const refusal = startRefusal({ kind: "hint", reason: "CI" }, "http://localhost:5173");
    expect(refusal?.title).toContain("headless environment (CI)");
    expect(refusal?.detail).toContain("http://localhost:5173");
    expect(refusal?.detail).toContain("aiui remote");
  });
});
