/**
 * The watchdog's whole job is to make a broken dev build *visible*. These tests
 * assert the three lies it exists to break — old code, dead server, empty
 * panel — each produce a banner a human cannot miss.
 */
import type { DevBuildState, DevStamp } from "@habemus-papadum/aiui-webext";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BANNER_ID, installBootWatchdog } from "./boot";

const stamp: DevStamp = {
  runId: "run-1",
  origin: "http://localhost:5317",
  port: 5317,
  startedAt: "2026-07-12T00:00:00.000Z",
};

function panelDocument(rendered: boolean): void {
  document.body.innerHTML = `<div id="root">${rendered ? "<span>app</span>" : ""}</div>`;
}

const banner = () => document.getElementById(BANNER_ID);

/** Let the injected check's promise settle and the grace timer fire. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10);
}

describe("the panel's boot watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    panelDocument(true);
  });

  it("says nothing when a production build renders", async () => {
    installBootWatchdog({
      graceMs: 0,
      check: async (): Promise<DevBuildState> => ({ kind: "production" }),
    });
    await settle();
    expect(banner()).toBeNull();
  });

  it("says nothing when a fresh dev build renders", async () => {
    installBootWatchdog({
      graceMs: 0,
      check: async (): Promise<DevBuildState> => ({ kind: "fresh", stamp }),
    });
    await settle();
    expect(banner()).toBeNull();
  });

  it("shouts when the extension is running an older dev run than the server serves", async () => {
    installBootWatchdog({
      graceMs: 0,
      check: async (): Promise<DevBuildState> => ({
        kind: "stale",
        stamp,
        serving: { ...stamp, runId: "run-2" },
      }),
    });
    await settle();
    expect(banner()?.textContent).toContain("STALE dev build");
    expect(banner()?.textContent).toContain("run-2");
  });

  it("shouts when the dev build's server is unreachable", async () => {
    installBootWatchdog({
      graceMs: 0,
      check: async (): Promise<DevBuildState> => ({ kind: "server-down", stamp }),
    });
    await settle();
    expect(banner()?.textContent).toContain("dev server unreachable");
    expect(banner()?.textContent).toContain("http://localhost:5317");
  });

  it("never leaves a blank panel blank — and names the exception that blanked it", async () => {
    panelDocument(false);
    installBootWatchdog({
      graceMs: 0,
      check: async (): Promise<DevBuildState> => ({ kind: "production" }),
    });
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("[MISSING_EFFECT_FN]"), message: "boom" }),
    );
    await settle();
    expect(banner()?.textContent).toContain("the panel did not render");
    expect(banner()?.textContent).toContain("MISSING_EFFECT_FN");
  });

  it("offers a reload button (the only thing that re-reads an unpacked extension)", async () => {
    panelDocument(false);
    const reload = vi.fn();
    installBootWatchdog({
      graceMs: 0,
      reload,
      check: async (): Promise<DevBuildState> => ({ kind: "production" }),
    });
    await settle();
    banner()?.querySelector("button")?.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
