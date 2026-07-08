import { describe, expect, it } from "vitest";
import { IPAD_CLIENT_HTML } from "./ipad-client";

/**
 * The iPad client ships as a verbatim asset file (assets/ipad-client.html).
 * These tests parse what actually ships: when the page lived inside a TS
 * template literal, a `"\n"` typed into the inline JS shipped a raw newline
 * inside a string literal and killed the whole client with a SyntaxError —
 * the page then sat on "Connecting…" forever, which cost a real debugging
 * round. The asset file removed the escaping layer; the parse check stays as
 * the guard on whatever the module actually exports.
 */
describe("IPAD_CLIENT_HTML", () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(IPAD_CLIENT_HTML)?.[1];

  it("loads the asset and carries one inline script", () => {
    expect(IPAD_CLIENT_HTML).toContain("<!doctype html>");
    expect(script).toBeTruthy();
  });

  it("the inline script is syntactically valid JS (as served)", () => {
    // `new Function` parses without executing — a SyntaxError throws here.
    expect(() => new Function(script ?? "")).not.toThrow();
  });
});
