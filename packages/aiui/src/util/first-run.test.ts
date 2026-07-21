import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, readConfigFile } from "./config";
import { ensureLaunchChoices } from "./first-run";

let dir: string;
let prevCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiui-first-run-"));
  prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = dir; // sandbox the user config the answers persist to
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.AIUI_CACHE;
  else process.env.AIUI_CACHE = prevCache;
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureLaunchChoices", () => {
  it("asks nothing: the nudge is disabled and bind is no longer a first-run question", async () => {
    // ENTER_NUDGE_ENABLED=false holds the one remaining question, and the bind
    // posture is deliberately NOT asked here — it defaults to loopback and the
    // only opt-in to host is `aiui config yolo`. So nothing prompts, nothing
    // persists, and channel.bind stays unset (→ loopback at launch).
    const config = await ensureLaunchChoices({}, async () => {
      throw new Error("should not prompt");
    });
    expect(config).toEqual({});
    expect(config.channel).toBeUndefined();
    expect(readConfigFile(configPath())).toBeUndefined();
  });

  it("leaves an already-configured config untouched", async () => {
    const config = {
      claude: { enterNudge: false },
      channel: { bind: "loopback" as const },
    };
    const result = await ensureLaunchChoices(config, async () => {
      throw new Error("should not prompt");
    });
    expect(result).toEqual(config);
  });

  it("never sets channel.bind — host is opt-in via `aiui config yolo` only", async () => {
    const result = await ensureLaunchChoices({ claude: {} }, async () => {
      throw new Error("should not prompt");
    });
    expect(result.channel).toBeUndefined();
    expect(readConfigFile(configPath())?.channel).toBeUndefined();
  });
});
