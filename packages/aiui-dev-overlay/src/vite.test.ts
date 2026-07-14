/**
 * vite.test.ts — the DEPRECATED wrapper (the 2026-07-14 plugin restructure).
 * The old suite pinned the retired injections (port seed, mount script, tools
 * bridge, session bus); those behaviors are deliberately gone — the wrapper's
 * whole contract is: warn once, delegate the LOCATOR to viz's aiui().
 */
import { describe, expect, it, vi } from "vitest";
import { aiuiDevOverlay } from "./vite";

describe("aiuiDevOverlay (deprecated wrapper)", () => {
  it("warns and returns the locator plugins — nothing dev-server-magic", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plugins = aiuiDevOverlay({ locator: true });
      const list = Array.isArray(plugins) ? plugins : [plugins];
      expect(list.length).toBeGreaterThan(0);
      const names = list.map((p) => p.name);
      // The locator pass is present; the retired injections are not.
      expect(names.some((n) => n.includes("source-locator") || n.includes("aiui"))).toBe(true);
      expect(names.some((n) => n.includes("mount") || n.includes("port"))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
    } finally {
      warn.mockRestore();
    }
  });

  it("passes the old cellFactories sugar through to the moved pass", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plugins = aiuiDevOverlay({ locator: { cellFactories: ["cell"] } });
      expect(Array.isArray(plugins) ? plugins.length : 1).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});
