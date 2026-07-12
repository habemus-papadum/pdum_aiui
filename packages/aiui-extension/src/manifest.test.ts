// @vitest-environment node
// (defineManifest pulls the CRXJS/esbuild chain, and esbuild's TextEncoder
// invariant breaks under jsdom — the model-layer tests are what need jsdom.)
import { describe, expect, it } from "vitest";
import manifest from "../manifest.config";

// The manifest is authored through defineManifest (which may accept a promise/
// function form); ours is a plain object — assert the fields Chrome cares about.
describe("extension manifest", () => {
  const m = manifest as unknown as Record<string, unknown>;

  it("is MV3 with a plain dotted version (Chrome rejects +dev suffixes)", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.version).toMatch(/^\d+(\.\d+)*$/);
  });

  it("declares the panel, worker, and permissions", () => {
    expect(m.side_panel).toEqual({ default_path: "src/panel/index.html" });
    expect(m.background).toEqual({ service_worker: "src/sw.ts", type: "module" });
    expect(m.permissions).toEqual([
      "sidePanel",
      "storage",
      "nativeMessaging",
      "tabs",
      "tabCapture",
    ]);
  });

  it("pins the stable id and ships the aiui icon", () => {
    expect(typeof m.key).toBe("string");
    expect((m.icons as Record<string, string>)["128"]).toBe("icons/icon128.png");
  });
});
