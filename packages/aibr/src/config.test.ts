import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture } from "../test/helpers.ts";
import { defaultConfig, loadConfig, parseConfig, selectTarget, updateConfig } from "./config.ts";
import { parseProfile, parseTarget } from "./model.ts";
import { createProfile, editProfile, readProfile } from "./profiles.ts";
import { paths, writeJson } from "./storage.ts";

describe("configuration and profiles", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.cleanup();
  });

  it("resolves CLI > nearest ancestor > user default without merging ancestors", async () => {
    const parent = join(f.root, "project");
    const child = join(parent, "child");
    const leaf = join(child, "leaf");
    await mkdir(leaf, { recursive: true });
    await writeJson(join(parent, ".aiui.json"), {
      schemaVersion: 1,
      browser: { target: "parent" },
    });
    await writeJson(join(child, ".aiui.json"), { schemaVersion: 1, browser: { target: "child" } });
    const config = defaultConfig();
    config.defaultTarget = "user";
    expect((await selectTarget(config, {}, leaf)).label).toBe("child");
    expect((await selectTarget(config, { profile: "cli" }, leaf)).label).toBe("cli");
    expect((await selectTarget(config, {}, f.root)).label).toBe("user");
  });
  it("rejects malformed project config, while explicit selection bypasses it", async () => {
    await writeFile(join(f.root, ".aiui.json"), "not json");
    await expect(selectTarget(defaultConfig(), {}, f.root)).rejects.toThrow("Cannot read");
    expect((await selectTarget(defaultConfig(), { target: "explicit" }, f.root)).label).toBe(
      "explicit",
    );
  });
  it("rejects conflicting selectors and arbitrary project provider commands", async () => {
    await expect(
      selectTarget(defaultConfig(), { profile: "a", endpoint: "http://localhost:9222" }, f.root),
    ).rejects.toThrow("only one");
    await writeJson(join(f.root, ".aiui.json"), {
      schemaVersion: 1,
      browser: { target: "a", command: "evil" },
    });
    await expect(selectTarget(defaultConfig(), {}, f.root)).rejects.toThrow("Unknown");
  });
  it("preserves independently saved updates under concurrency", async () => {
    await Promise.all([
      updateConfig(f.p, (c) => {
        c.agents.claude.yolo = true;
      }),
      updateConfig(f.p, (c) => {
        c.agents.codex.args = ["--model", "example"];
      }),
    ]);
    const config = await loadConfig(f.p);
    expect(config.agents.claude.yolo).toBe(true);
    expect(config.agents.codex.args).toEqual(["--model", "example"]);
  });
  it("allocates distinct concrete ports and durable directories", async () => {
    const [a, b] = await Promise.all([createProfile(f.p, "a"), createProfile(f.p, "b")]);
    expect(a.profile.launch.debugPort).toBeGreaterThan(0);
    expect(a.profile.launch.debugPort).not.toBe(b.profile.launch.debugPort);
    expect(a.dir).not.toContain(f.p.cache);
    expect((await createProfile(f.p, "ephemeral", { debugPort: 0 })).profile.launch.debugPort).toBe(
      0,
    );
  });
  it("does not overwrite profiles or claim populated directories without adopt", async () => {
    const { dir } = await createProfile(f.p, "a");
    await expect(createProfile(f.p, "a")).rejects.toThrow("already exists");
    const external = join(f.root, "external");
    await mkdir(external);
    await writeFile(join(external, "cookies"), "keep");
    await expect(createProfile(f.p, "ext", { dataDir: external })).rejects.toThrow("not empty");
    await createProfile(f.p, "ext", { dataDir: external, adopt: true });
    expect(await readFile(join(external, "cookies"), "utf8")).toBe("keep");
    await expect(
      editProfile(dir, (p) => {
        p.browser = { managed: "chrome-for-testing" };
      }),
    ).rejects.toThrow("cannot change");
  });
  it("fails on corrupt metadata and reserved flags instead of changing browsers", async () => {
    const { dir, profile } = await createProfile(f.p, "a");
    expect(() =>
      parseProfile({
        ...profile,
        launch: { ...profile.launch, extraArgs: ["--user-data-dir=/tmp/other"] },
      }),
    ).toThrow("structured settings");
    await writeFile(join(dir, "aibr-profile.json"), "{}");
    await expect(readProfile(dir)).rejects.toThrow("schemaVersion");
  });
  it("validates target kinds, names and agent defaults", () => {
    expect(() => parseTarget({ profile: "../../elsewhere" })).toThrow("Invalid name");
    expect(() => parseTarget({ profile: "a", endpoint: "http://localhost:1" })).toThrow("Unknown");
    expect(() => parseConfig({ schemaVersion: 1, agents: { codex: { yolo: "yes" } } })).toThrow(
      "boolean",
    );
    expect(parseConfig({ schemaVersion: 1 }).agents.codex.yolo).toBe(false);
    expect(paths({}, "/home/example", "linux").data).toBe("/home/example/.local/share/aibr");
    expect(paths({}, "/Users/example", "darwin").cache).toContain("Library/Caches/aibr");
  });
});
