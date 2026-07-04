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
  it("asks for both unset choices, persists, and applies them", async () => {
    const questions: string[] = [];
    const config = await ensureLaunchChoices({}, async (question) => {
      questions.push(question);
      return questions.length === 1 ? "n" : "y"; // no to skip, yes to nudge
    });

    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatch(/skip-permissions/i);
    expect(questions[1]).toMatch(/channel prompt/i);
    expect(config.claude).toEqual({ skipPermissions: false, enterNudge: true });

    const persisted = readConfigFile(configPaths().user);
    expect(persisted?.claude).toEqual({ skipPermissions: false, enterNudge: true });
  });

  it("asks nothing when both are already configured", async () => {
    const config = { claude: { skipPermissions: true, enterNudge: false } };
    const result = await ensureLaunchChoices(config, async () => {
      throw new Error("should not prompt");
    });
    expect(result).toEqual(config);
  });

  it("asks only for the missing choice", async () => {
    const questions: string[] = [];
    const result = await ensureLaunchChoices({ claude: { skipPermissions: false } }, async (q) => {
      questions.push(q);
      return "n";
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/channel prompt/i);
    expect(result.claude).toEqual({ skipPermissions: false, enterNudge: false });
  });
});
