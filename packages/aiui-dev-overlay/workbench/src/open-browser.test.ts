import { describe, expect, it } from "vitest";
import { workbenchBrowserAction } from "./open-browser";

describe("workbenchBrowserAction", () => {
  it("opens by default on a machine with a display", () => {
    expect(workbenchBrowserAction({}, "darwin")).toEqual({ kind: "open" });
    expect(workbenchBrowserAction({ DISPLAY: ":0" }, "linux")).toEqual({ kind: "open" });
  });

  it("hints instead of opening in headless environments, carrying the reason", () => {
    expect(workbenchBrowserAction({ CI: "true" }, "darwin")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/CI/),
    });
    expect(workbenchBrowserAction({ SSH_TTY: "/dev/pts/0" }, "darwin")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/SSH/),
    });
    expect(workbenchBrowserAction({}, "linux")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/DISPLAY/),
    });
  });

  it("WORKBENCH_BROWSER=1 forces an open even under CI", () => {
    expect(workbenchBrowserAction({ CI: "true", WORKBENCH_BROWSER: "1" }, "linux")).toEqual({
      kind: "open",
    });
  });

  it("WORKBENCH_BROWSER=0 suppresses, even with a display", () => {
    expect(workbenchBrowserAction({ WORKBENCH_BROWSER: "0" }, "darwin")).toEqual({ kind: "skip" });
  });

  it("ignores values that are neither 0 nor 1", () => {
    // Neither force nor suppress — the default ladder decides.
    expect(workbenchBrowserAction({ WORKBENCH_BROWSER: "yes" }, "darwin")).toEqual({
      kind: "open",
    });
    expect(workbenchBrowserAction({ WORKBENCH_BROWSER: "yes", CI: "true" }, "darwin")).toEqual({
      kind: "hint",
      reason: expect.stringMatching(/CI/),
    });
  });
});
