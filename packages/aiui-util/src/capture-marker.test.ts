import { describe, expect, it } from "vitest";
import { CAPTURE_MARKER_SOURCE, rehostSocketUrl } from "./capture-marker";

describe("CAPTURE_MARKER_SOURCE", () => {
  it("defines the exact global the overlay's broker reads", () => {
    // The reader is packages/aiui-dev-overlay/src/multimodal/display-capture.ts
    // (`window.__AIUI_CAPTURE__ === "auto"`). The two live in different packages
    // and meet only through this string.
    expect(CAPTURE_MARKER_SOURCE).toBe('window.__AIUI_CAPTURE__ = "auto";');
  });

  it("is idempotent — two installers on one browser must not conflict", () => {
    const window: Record<string, unknown> = {};
    new Function("window", CAPTURE_MARKER_SOURCE)(window);
    new Function("window", CAPTURE_MARKER_SOURCE)(window);
    expect(window.__AIUI_CAPTURE__).toBe("auto");
  });
});

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
