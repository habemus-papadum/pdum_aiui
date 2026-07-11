import { describe, expect, it } from "vitest";
import { dataUrlToBytes, isNotInvokedError } from "./capture";

describe("dataUrlToBytes", () => {
  it("decodes the base64 body", () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const b64 = Buffer.from(bytes).toString("base64");
    expect(dataUrlToBytes(`data:image/png;base64,${b64}`)).toEqual(bytes);
  });

  it("throws on a payload-less string (surfaced by the shot's catch)", () => {
    expect(() => dataUrlToBytes("nonsense")).toThrow(/data URL/);
  });
});

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
