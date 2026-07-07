import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPaths, readConfigFile } from "./config";
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
    const questions: string[] = [];
    const config = await ensureLaunchChoices({}, async (question) => {
      questions.push(question);
      if (questions.length === 1) return "n"; // no to skip
      if (questions.length === 2) return "y"; // yes to nudge
      return "h"; // bind the host interface
    });

    expect(questions).toHaveLength(3);
    expect(questions[0]).toMatch(/skip-permissions/i);
    expect(questions[1]).toMatch(/channel prompt/i);
    expect(questions[2]).toMatch(/web server bind/i);
    expect(config.claude).toEqual({ skipPermissions: false, enterNudge: true });
    expect(config.channel).toEqual({ bind: "host" });

    const persisted = readConfigFile(configPaths().user);
    expect(persisted?.claude).toEqual({ skipPermissions: false, enterNudge: true });
    expect(persisted?.channel).toEqual({ bind: "host" });
  });

  it("asks nothing when everything is already configured", async () => {
    const config = {
      claude: { skipPermissions: true, enterNudge: false },
      channel: { bind: "loopback" as const },
    };
    const result = await ensureLaunchChoices(config, async () => {
      throw new Error("should not prompt");
    });
    expect(result).toEqual(config);
  });

  it("asks only for the missing choices", async () => {
    const questions: string[] = [];
    const result = await ensureLaunchChoices(
      { claude: { skipPermissions: false }, channel: { bind: "host" } },
      async (q) => {
        questions.push(q);
        return "n";
      },
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/channel prompt/i);
    expect(result.claude).toEqual({ skipPermissions: false, enterNudge: false });
    expect(result.channel).toEqual({ bind: "host" });
  });

  it("choosing loopback persists it, so it never asks again", async () => {
    const config = await ensureLaunchChoices(
      { claude: { skipPermissions: true, enterNudge: true } },
      async () => "l",
    );
    expect(config.channel).toEqual({ bind: "loopback" });
    expect(readConfigFile(configPaths().user)?.channel).toEqual({ bind: "loopback" });
  });
});
