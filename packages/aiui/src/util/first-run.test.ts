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
      return questions.length === 1 ? "n" : "y"; // no to skip; yes to nudge + paint
    });

    expect(questions).toHaveLength(3);
    expect(questions[0]).toMatch(/skip-permissions/i);
    expect(questions[1]).toMatch(/channel prompt/i);
    expect(questions[2]).toMatch(/iPad paint/i);
    expect(config.claude).toEqual({ skipPermissions: false, enterNudge: true });
    expect(config.sidecars).toEqual({ paint: true });

    const persisted = readConfigFile(configPaths().user);
    expect(persisted?.claude).toEqual({ skipPermissions: false, enterNudge: true });
    expect(persisted?.sidecars).toEqual({ paint: true });
  });

  it("asks nothing when everything is already configured", async () => {
    const config = {
      claude: { skipPermissions: true, enterNudge: false },
      sidecars: { paint: false },
    };
    const result = await ensureLaunchChoices(config, async () => {
      throw new Error("should not prompt");
    });
    expect(result).toEqual(config);
  });

  it("asks only for the missing choices", async () => {
    const questions: string[] = [];
    const result = await ensureLaunchChoices(
      { claude: { skipPermissions: false }, sidecars: { paint: false } },
      async (q) => {
        questions.push(q);
        return "n";
      },
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/channel prompt/i);
    expect(result.claude).toEqual({ skipPermissions: false, enterNudge: false });
    expect(result.sidecars).toEqual({ paint: false });
  });

  it("declining paint persists false, so it never asks again", async () => {
    const config = await ensureLaunchChoices(
      { claude: { skipPermissions: true, enterNudge: true } },
      async () => "n",
    );
    expect(config.sidecars).toEqual({ paint: false });
    expect(readConfigFile(configPaths().user)?.sidecars).toEqual({ paint: false });
  });
});
