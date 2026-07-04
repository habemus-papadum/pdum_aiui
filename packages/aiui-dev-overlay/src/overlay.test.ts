// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isDevEnvironment, mountDevOverlay, unmountDevOverlay } from "./overlay";

const HOST_ID = "aiui-dev-overlay-host";

afterEach(() => {
  // Clean up any overlay so DOM / global state doesn't leak between tests.
  unmountDevOverlay();
});

describe("mountDevOverlay", () => {
  it("creates a host element with a shadow root containing the button", () => {
    const handle = mountDevOverlay({ force: true });

    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    expect(handle.shadowRoot).not.toBeNull();
    expect(host?.shadowRoot).toBe(handle.shadowRoot);

    const button = handle.shadowRoot?.querySelector(".aiui-button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("aiui");
  });

  it("guards against double-injection (returns the same handle, one host)", () => {
    const first = mountDevOverlay({ force: true });
    const second = mountDevOverlay({ force: true });

    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${HOST_ID}`).length).toBe(1);
    expect(window.__aiuiDevOverlay).toBe(first);
  });

  it("toggles / opens / closes the placeholder panel", () => {
    const handle = mountDevOverlay({ force: true });
    const panel = handle.shadowRoot?.querySelector<HTMLElement>(".aiui-panel");
    expect(panel?.hidden).toBe(true);

    handle.open();
    expect(panel?.hidden).toBe(false);

    handle.close();
    expect(panel?.hidden).toBe(true);

    handle.toggle();
    expect(panel?.hidden).toBe(false);
  });

  it("unmount() removes the host and clears the global guard", () => {
    const handle = mountDevOverlay({ force: true });
    expect(document.getElementById(HOST_ID)).not.toBeNull();

    handle.unmount();

    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(window.__aiuiDevOverlay).toBeUndefined();
  });
});

describe("isDevEnvironment", () => {
  it("is true under jsdom's default localhost URL", () => {
    // jsdom serves pages from http://localhost/, which the heuristic treats as dev.
    expect(location.hostname).toBe("localhost");
    expect(isDevEnvironment()).toBe(true);
  });
});
