import { describe, expect, it } from "vitest";
import { rehostSocketUrl } from "./socket-url";

describe("rehostSocketUrl", () => {
  it("keeps the browser's session path, takes the authority we reached it on", () => {
    // Chrome always reports 127.0.0.1 plus ITS port — true only on its own
    // machine. A tunneled browser (docs/guide/remote) answers on the forwarded
    // port, and dialing what it said would reach nothing.
    expect(
      rehostSocketUrl("ws://127.0.0.1:9222/devtools/browser/2f1c-4b8e", "http://127.0.0.1:57873"),
    ).toBe("ws://127.0.0.1:57873/devtools/browser/2f1c-4b8e");
  });

  it("upgrades to wss for an https endpoint", () => {
    expect(
      rehostSocketUrl("ws://127.0.0.1:9222/devtools/browser/x", "https://dev.example.com"),
    ).toBe("wss://dev.example.com/devtools/browser/x");
  });

  it("tolerates a trailing slash on the endpoint", () => {
    expect(
      rehostSocketUrl("ws://127.0.0.1:9222/devtools/browser/x", "http://box.local:9333/"),
    ).toBe("ws://box.local:9333/devtools/browser/x");
  });
});
