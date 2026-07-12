import { describe, expect, it } from "vitest";
import { isNotInvokedError } from "./capture";

describe("isNotInvokedError", () => {
  it("matches the measured invocation-gate string (RESULTS.md M4a)", () => {
    expect(
      isNotInvokedError(
        "Extension has not been invoked for the current page (see activeTab permission). " +
          "Chrome pages cannot be captured.",
      ),
    ).toBe(true);
  });

  it("stays quiet for other capture failures", () => {
    expect(isNotInvokedError("Cannot capture a tab with an active stream.")).toBe(false);
    expect(isNotInvokedError("could not connect")).toBe(false);
  });
});
