import { once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture } from "../test/helpers.ts";
import { YOLO_FLAGS } from "./agents.ts";
import { ensureBrowser, stopBrowser } from "./browser.ts";
import { probeEndpoint } from "./cdp.ts";
import { loadConfig } from "./config.ts";
import { createProfile, profileDir, readProfile } from "./profiles.ts";

describe("CLI and exec", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let dir: string | undefined;
  beforeEach(async () => {
    f = await fixture();
    dir = undefined;
  });
  afterEach(async () => {
    if (dir) {
      try {
        await stopBrowser(f.p, dir);
      } catch {
        /* Closed. */
      }
    }
    await f.cleanup();
  });
  async function browser() {
    dir = (
      await createProfile(f.p, "default", { browser: { executable: f.browser }, debugPort: 0 })
    ).dir;
    return ensureBrowser(f.p, dir);
  }
  it("saves both alias-compatible YOLO defaults with one command", async () => {
    await f.run(["config", "yolo", "on"]);
    const config = await loadConfig(f.p);
    expect(config.agents.claude.yolo).toBe(true);
    expect(config.agents.codex.yolo).toBe(true);
    await f.run(["config", "yolo", "off", "--agent", "codex"]);
    expect((await loadConfig(f.p)).agents.codex.yolo).toBe(false);
    expect((await loadConfig(f.p)).agents.claude.yolo).toBe(true);
  });
  it("persists arbitrary defaults and allows one-launch opt-outs", async () => {
    await browser();
    await f.run(["config", "args", "codex", "--", "--model", "model with spaces"]);
    await f.run(["config", "yolo"]);
    const plan = JSON.parse((await f.run(["codex", "--dry-run"])).stdout).plan;
    expect(plan.args.slice(0, 3)).toEqual(["--model", "model with spaces", YOLO_FLAGS.codex]);
    const safe = JSON.parse((await f.run(["codex", "--dry-run", "--no-yolo"])).stdout).plan;
    expect(safe.args).toContain("model with spaces");
    expect(safe.args).not.toContain(YOLO_FLAGS.codex);
    const clean = JSON.parse(
      (await f.run(["codex", "--dry-run", "--no-default-args"])).stdout,
    ).plan;
    expect(clean.args).not.toContain("model with spaces");
    expect(clean.args).not.toContain(YOLO_FLAGS.codex);
    expect((await loadConfig(f.p)).agents.codex.yolo).toBe(true);
  });
  it("turning YOLO off removes a bypass flag stored as an arbitrary default", async () => {
    await f.run(["config", "args", "claude", "--", "--model", "opus", YOLO_FLAGS.claude]);
    await f.run(["config", "yolo", "off"]);
    expect((await loadConfig(f.p)).agents.claude.args).toEqual(["--model", "opus"]);
  });
  it("the global MCP entry refuses to start a stopped browser", async () => {
    dir = (
      await createProfile(f.p, "default", { browser: { executable: f.browser }, debugPort: 0 })
    ).dir;
    await expect(f.run(["mcp"])).rejects.toThrow("Browser is stopped");
    await expect(readFile(`${dir}/DevToolsActivePort`)).rejects.toThrow();
  });
  it("exec replaces the launcher PID and preserves argument boundaries and exit code", async () => {
    const connection = await browser();
    const child = f.spawn(["codex", "--", "a 'quoted' prompt $(literal)"], {
      AIBR_TEST_EXIT: "23",
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const [code] = await once(child, "exit");
    const output = JSON.parse(stdout);
    expect(output.pid).toBe(child.pid);
    expect(output.args.at(-1)).toBe("a 'quoted' prompt $(literal)");
    expect(output.cwd).toBe(await realpath(f.root));
    expect(code).toBe(23);
    await probeEndpoint(connection.wsEndpoint);
  });
  it("delivers signals directly to the exec'd agent without closing the browser", async () => {
    const connection = await browser();
    const child = f.spawn(["claude", "--", "hello"], { AIBR_TEST_WAIT: "1" });
    try {
      const exited = once(child, "exit");
      const [data] = await once(child.stdout, "data");
      expect(JSON.parse(String(data)).pid).toBe(child.pid);
      child.kill("SIGINT");
      expect((await exited)[0]).toBe(17);
      await probeEndpoint(connection.wsEndpoint);
    } finally {
      child.kill("SIGKILL");
    }
  });
  it("help and native help do not create state", async () => {
    expect((await f.run(["--help"])).stdout).toContain("aibr");
    const native = JSON.parse((await f.run(["claude", "--", "--help"])).stdout);
    expect(native.args).toEqual(["--help"]);
    await expect(readFile(f.p.config)).rejects.toThrow();
  });
  it("does not change headless when setting a different profile option", async () => {
    await f.run(["profile", "create", "a", "--debug-port", "0", "--headless"]);
    await f.run(["profile", "set", "a", "--media", "standard"]);
    expect((await readProfile(profileDir(f.p, "a"))).launch.headless).toBe(true);
  });
  it("rejects MCP passthrough overrides before attempting to start a browser", async () => {
    await expect(f.run(["claude", "--", "--mcp-config", "evil.json"])).rejects.toThrow("aibr owns");
    await expect(f.run(["codex", "--pick"])).rejects.toThrow("interactive terminal");
  });
});
