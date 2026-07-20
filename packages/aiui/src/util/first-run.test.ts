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
  it("asks for every unset choice, persists, and applies them", async () => {
    // While the enter-nudge mechanism is disabled (ENTER_NUDGE_ENABLED=false),
    // its question is skipped — asking for a preference nothing acts on is
    // worse than either answer — so the bind posture is the one live question.
    const questions: string[] = [];
    const config = await ensureLaunchChoices({}, async (question) => {
      questions.push(question);
      return "h"; // bind the host interface
    });

    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/web server bind/i);
    expect(config.claude?.enterNudge).toBeUndefined();
    expect(config.channel).toEqual({ bind: "host" });

    const persisted = readConfigFile(configPath());
    expect(persisted?.channel).toEqual({ bind: "host" });
  });

  it("asks nothing when everything is already configured", async () => {
    const config = {
      claude: { enterNudge: false },
      channel: { bind: "loopback" as const },
    };
    const result = await ensureLaunchChoices(config, async () => {
      throw new Error("should not prompt");
    });
    expect(result).toEqual(config);
  });

  it("asks nothing once the bind posture is chosen (nudge question held while disabled)", async () => {
    const result = await ensureLaunchChoices(
      { claude: {}, channel: { bind: "host" } },
      async () => {
        throw new Error("should not prompt");
      },
    );
    expect(result.channel).toEqual({ bind: "host" });
  });

  it("choosing loopback persists it, so it never asks again", async () => {
    const config = await ensureLaunchChoices({ claude: { enterNudge: true } }, async () => "l");
    expect(config.channel).toEqual({ bind: "loopback" });
    expect(readConfigFile(configPath())?.channel).toEqual({ bind: "loopback" });
  });
});
