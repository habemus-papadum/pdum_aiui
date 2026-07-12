// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PCM_WORKLET_SOURCE } from "@habemus-papadum/aiui-dev-overlay/multimodal-talk";
import { describe, expect, it } from "vitest";

describe("public/pcm-worklet.js", () => {
  it("is byte-for-byte the shared PCM_WORKLET_SOURCE (after its header)", () => {
    // MV3 CSP blocks blob: worklet modules, so the panel ships the worklet as
    // a real file. This pin is what makes that copy drift-proof: change
    // audio.ts's constant and this fails until the file is regenerated.
    const shipped = readFileSync(join(__dirname, "..", "public", "pcm-worklet.js"), "utf8");
    const body = shipped
      .split("\n")
      .filter((l) => !l.startsWith("//"))
      .join("\n");
    expect(body.trim()).toBe(PCM_WORKLET_SOURCE.trim());
  });
});
