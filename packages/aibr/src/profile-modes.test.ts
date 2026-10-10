import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../test/helpers.ts";
import { temporaryMcpEntry } from "./agents.ts";
import { browserStatus, ensureBrowser, stopBrowser } from "./browser.ts";
import { probeEndpoint } from "./cdp.ts";
import { loadConfig, selectTarget, updateConfig } from "./config.ts";
import { createEndpointProfile, createProfile, profileDir, readProfile } from "./profiles.ts";
import { createProgram } from "./program.ts";
import { editProfileSetup, endpointInput, setupProfile, temporaryBrowser } from "./setup.ts";
import { writeJson } from "./storage.ts";
import { resolveTarget } from "./targets.ts";
import { type Choice, type Prompts, terminal } from "./ui.ts";

describe("profile editing and browser modes", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const running: string[] = [];
  beforeEach(async () => {
    f = await fixture();
    running.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of running) {
      try {
        await stopBrowser(f.p, dir);
      } catch {
        /* already stopped */
      }
    }
    await f.cleanup();
  });
  async function local(key = "local", headless = false) {
    const result = await createProfile(f.p, key, {
      debugPort: 0,
      headless,
      browser: { executable: f.browser },
    });
    running.push(result.dir);
    return result;
  }
  const defaults: Prompts = {
    interactive: true,
    note() {},
    async text(_message, fallback) {
      return fallback ?? "";
    },
    async choose<T>(_message: string, _choices: Choice<T>[], fallback?: T) {
      if (fallback === undefined) throw new Error("No prefilled value");
      return fallback;
    },
    async confirm(_message, fallback) {
      return fallback ?? false;
    },
  };

  it("shows formatted settings by default and keeps JSON explicitly available", async () => {
    await local();
    const human = (await f.run(["profile", "show", "local"])).stdout;
    expect(human).toContain("Mode: not headless");
    expect(human).toContain("Debug port: 0 (ephemeral)");
    expect(human).toContain("Extensions: none");
    expect(
      JSON.parse((await f.run(["profile", "show", "local", "--json"])).stdout).launch.headless,
    ).toBe(false);
  });

  it("prefills every editable value, preserves package extensions and does not move data", async () => {
    const { dir, profile } = await local();
    profile.launch.extensions = [{ package: "example", directory: "dist" }];
    profile.launch.extraArgs = ["--lang=en"];
    await writeJson(join(dir, "aibr-profile.json"), profile);
    await writeFile(join(dir, "cookie-marker"), "keep");
    await editProfileSetup(f.p, "local", {}, defaults);
    expect(await readProfile(dir)).toEqual(profile);
    expect(await readFile(join(dir, "cookie-marker"), "utf8")).toBe("keep");
    await editProfileSetup(
      f.p,
      "local",
      { headless: true, clearExtensions: true, clearChromeArgs: true },
      defaults,
    );
    expect((await readProfile(dir)).launch).toMatchObject({
      headless: true,
      extensions: [],
      extraArgs: [],
    });
  });

  it("the editor chooses a profile when unnamed and applies supplied values without prompting", async () => {
    const { dir } = await local();
    vi.spyOn(terminal, "interactive", "get").mockReturnValue(true);
    const picker = vi.spyOn(terminal, "choose").mockResolvedValue("local");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram(f.p).parseAsync(["profile", "edit", "--yes", "--headless"], {
      from: "user",
    });
    expect(picker).toHaveBeenCalledOnce();
    expect((await readProfile(dir)).launch.headless).toBe(true);
  });

  it("cancelling or racing an edit preserves the latest saved configuration", async () => {
    const { dir, profile } = await local();
    await expect(
      editProfileSetup(
        f.p,
        "local",
        {},
        {
          ...defaults,
          text: async () => {
            throw new Error("cancelled");
          },
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(await readProfile(dir)).toEqual(profile);
    const racing = {
      ...defaults,
      text: async () => {
        await f.run(["profile", "set", "local", "--media", "standard"]);
        return "0";
      },
    };
    await expect(editProfileSetup(f.p, "local", {}, racing)).rejects.toThrow(
      "changed during editing",
    );
    expect((await readProfile(dir)).launch.mediaPreset).toBe("standard");
  });

  it("persistent headless overrides preserve defaults and refuse to restart a shared browser", async () => {
    const { dir } = await local("local", true);
    const first = JSON.parse((await f.run(["browser", "start", "local", "--no-headless"])).stdout);
    expect((await browserStatus(f.p, dir)).runtime?.launch.headless).toBe(false);
    expect((await readProfile(dir)).launch.headless).toBe(true);
    await f.run(["claude", "--profile", "local", "--no-headless"]);
    await expect(f.run(["codex", "--profile", "local", "--headless"])).rejects.toThrow(
      "different settings",
    );
    await probeEndpoint(first.wsEndpoint);
    await stopBrowser(f.p, dir);
    await f.run(["codex", "--profile", "local"]);
    expect((await browserStatus(f.p, dir)).runtime?.launch.headless).toBe(true);
  });

  it("creates, selects, edits and removes endpoint profiles without any local browser data", async () => {
    await f.run([
      "profile",
      "create",
      "remote",
      "--host",
      "desktop.example",
      "--port",
      "19222",
      "--yes",
      "--use-here",
    ]);
    let config = await loadConfig(f.p);
    expect(config.targets.remote).toEqual({ endpoint: "http://desktop.example:19222" });
    expect((await selectTarget(config, {}, f.root)).target).toEqual(config.targets.remote);
    expect((await selectTarget(config, { profile: "remote" }, f.root)).target).toEqual(
      config.targets.remote,
    );
    const human = (await f.run(["profile", "show", "remote"])).stdout;
    expect(human).toContain("Endpoint: http://desktop.example:19222");
    expect(human).not.toContain("Debug port:");
    await f.run(["profile", "edit", "remote", "--port", "9223", "--yes"]);
    config = await loadConfig(f.p);
    expect(config.targets.remote).toEqual({ endpoint: "http://desktop.example:9223" });
    await expect(f.run(["browser", "start", "remote"])).rejects.toThrow("remote");
    await expect(f.run(["profile", "edit", "remote", "--headless", "--yes"])).rejects.toThrow(
      "browser host",
    );
    await f.run(["profile", "remove", "remote", "--yes"]);
    expect((await loadConfig(f.p)).targets.remote).toBeUndefined();
    await expect(readdir(f.p.data)).rejects.toThrow();
  });

  it("the endpoint interview accepts localhost or a full URL and asks no local launch questions", async () => {
    const questions: string[] = [];
    const text = vi.fn(async (message: string, fallback?: string) => {
      questions.push(message);
      if (message.startsWith("Endpoint URL")) return "localhost";
      if (message === "Endpoint port") return "19222";
      return fallback ?? "";
    });
    const ui = { ...defaults, text };
    const result = await setupProfile(f.p, "endpoint", { remote: true }, false, ui);
    expect(result.endpoint).toBe("http://localhost:19222");
    expect(questions).toEqual(["Endpoint URL, hostname, or localhost port", "Endpoint port"]);
    await editProfileSetup(
      f.p,
      "endpoint",
      {},
      { ...defaults, text: async (_msg, fallback) => fallback ?? "" },
    );
    expect((await loadConfig(f.p)).targets.endpoint).toEqual({
      endpoint: "http://localhost:19222",
    });
    expect(endpointInput("19223")).toBe("http://localhost:19223");
    expect(endpointInput("localhost:80")).toBe("http://localhost");
    expect(endpointInput("::1", 9222)).toBe("http://[::1]:9222");
    expect(endpointInput("https://example.test/cdp")).toBe("https://example.test/cdp");
  });

  it("endpoint connections only attach, and headless overrides fail before connecting", async () => {
    const { dir } = await local();
    const connection = await ensureBrowser(f.p, dir);
    await createEndpointProfile(f.p, "remote", connection.endpoint);
    const config = await loadConfig(f.p);
    const selected = await selectTarget(config, { profile: "remote" }, f.root);
    expect((await resolveTarget(f.p, config, selected.target)).wsEndpoint).toBe(
      connection.wsEndpoint,
    );
    await expect(
      resolveTarget(f.p, config, selected.target, true, { headless: false }),
    ).rejects.toThrow("only attach");
    await f.run(["claude", "--profile", "remote"]);
    await probeEndpoint(connection.wsEndpoint);
    await stopBrowser(f.p, dir);
    await expect(f.run(["codex", "--profile", "remote"])).rejects.toThrow();
    expect((await browserStatus(f.p, dir)).state).toBe("stopped");
  });

  it("temporary plans bypass project selection and leave browser startup entirely to MCP", async () => {
    await writeFile(join(f.root, ".aiui.yaml"), "invalid: config");
    for (const agent of ["claude", "codex"]) {
      const result = JSON.parse(
        (await f.run([agent, "--temp-headless", "--executable", f.browser, "--dry-run"])).stdout,
      );
      expect(result.selection).toMatchObject({
        mode: "temporary",
        headless: true,
        lifecycle: "MCP-owned",
      });
      expect(JSON.stringify(result.plan)).toContain("--isolated");
      expect(JSON.stringify(result.plan)).not.toContain("--ws-endpoint");
      expect(JSON.stringify(result.plan)).not.toContain("--user-data-dir");
      await f.run([agent, "--temp", "--executable", f.browser]);
    }
    await expect(readdir(f.p.data)).rejects.toThrow();
    await expect(readdir(f.p.state)).rejects.toThrow();
    const entry = await temporaryMcpEntry(f.browser, false);
    expect(entry.args).toContain("--headless=false");
    expect(entry.args).toContain("--chrome-arg=--auto-accept-camera-and-microphone-capture");
  });

  it("temporary browser selection is automatic for one usable family and explicit for several", async () => {
    await expect(temporaryBrowser(f.p, {})).rejects.toThrow("No usable");
    await writeJson(join(f.p.state, "browser-chromium.json"), { executable: f.browser });
    expect(await temporaryBrowser(f.p, {})).toBe(f.browser);
    await writeJson(join(f.p.state, "browser-chrome-for-testing.json"), {
      executable: process.execPath,
    });
    await expect(temporaryBrowser(f.p, {}, { ...defaults, interactive: false })).rejects.toThrow(
      "Multiple browser families",
    );
    expect(await temporaryBrowser(f.p, { browser: "cft" })).toBe(process.execPath);
    let choiceCount = 0;
    const choose = async <T>(_msg: string, choices: Choice<T>[]) => {
      choiceCount++;
      return choices[1].value;
    };
    expect(await temporaryBrowser(f.p, {}, { ...defaults, choose })).toBe(process.execPath);
    expect(choiceCount).toBe(1);
  });

  it.each([
    ["--temp", "--profile", "local"],
    ["--temp-headless", "--endpoint", "http://localhost:9222"],
    ["--temp", "--pick"],
    ["--temp", "--auto-connect"],
    ["--temp", "--temp-headless"],
    ["--temp-headless", "--no-headless"],
    ["--browser", "chromium"],
  ])("rejects conflicting launch modes before touching a browser: %j", async (...args) => {
    await expect(f.run(["claude", ...args])).rejects.toThrow();
    await expect(readdir(f.p.data)).rejects.toThrow();
  });

  it("endpoint aliases resolve once and cyclic references fail clearly", async () => {
    await createEndpointProfile(f.p, "remote", "http://localhost:9222");
    await updateConfig(f.p, (c) => {
      c.targets.alias = { profile: "remote" };
    });
    expect(
      (await selectTarget(await loadConfig(f.p), { profile: "alias" }, f.root)).target,
    ).toEqual({ endpoint: "http://localhost:9222" });
    await updateConfig(f.p, (c) => {
      c.targets.a = { profile: "b" };
      c.targets.b = { profile: "a" };
    });
    await expect(selectTarget(await loadConfig(f.p), { profile: "a" }, f.root)).rejects.toThrow(
      "Circular",
    );
    await expect(readFile(join(profileDir(f.p, "remote"), "aibr-profile.json"))).rejects.toThrow();
  });
});
