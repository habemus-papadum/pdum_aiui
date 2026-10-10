import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Browser, computeExecutablePath, detectBrowserPlatform } from "@puppeteer/browsers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../test/helpers.ts";
import { defaultConfig, loadConfig, selectTarget, updateConfig } from "./config.ts";
import { diagnose, offerSetup } from "./doctor.ts";
import * as browsers from "./installations.ts";
import { createProfile, profileDir, readProfile } from "./profiles.ts";
import { createProgram } from "./program.ts";
import { findProject, readProject, writeProject } from "./project.ts";
import { chooseBrowser, setupProfile } from "./setup.ts";
import { writeJson } from "./storage.ts";
import { type Choice, type Prompts, terminal } from "./ui.ts";

function answers(texts: string[] = [], choices: unknown[] = [], confirmations: boolean[] = []) {
  const questions: string[] = [];
  const ui: Prompts = {
    interactive: true,
    note() {},
    async text(message, fallback, validate) {
      questions.push(message);
      if (!texts.length) throw new Error(`Unexpected question: ${message}`);
      const answer = texts.shift() || fallback || "";
      validate?.(answer);
      return answer;
    },
    async choose<T>(message: string, options: Choice<T>[]) {
      questions.push(message);
      const answer = choices.shift();
      const choice = options.find((option) => option.value === answer);
      if (!choice) throw new Error(`Unexpected choice: ${message} (${String(answer)})`);
      return choice.value;
    },
    async confirm(message) {
      questions.push(message);
      if (!confirmations.length) throw new Error(`Unexpected confirmation: ${message}`);
      return confirmations.shift() as boolean;
    },
  };
  return { ui, questions, texts, choices, confirmations };
}

describe("discoverable setup and inventory", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.cleanup();
  });

  it("lists installed builds and selected executables without downloading", async () => {
    const platform = detectBrowserPlatform();
    const cacheDir = join(f.p.cache, "browsers");
    const executable = computeExecutablePath({
      cacheDir,
      platform,
      browser: Browser.CHROME,
      buildId: "123.0.0.1",
    });
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    await writeJson(join(f.p.state, "browser-chrome-for-testing.json"), {
      buildId: "123.0.0.1",
      executable,
    });
    const list = JSON.parse((await f.run(["browser", "list", "--json"])).stdout);
    expect(list).toEqual([
      expect.objectContaining({
        family: "chrome-for-testing",
        executable,
        selected: true,
        available: true,
      }),
    ]);
    expect((await f.run(["browser", "list"])).stdout).toContain("selected for new launches");
    const report = JSON.parse((await f.run(["doctor", "--json"])).stdout);
    expect(report.installations.value).toEqual(list);
    expect(report.globalDefault.state).toBe("missing profile");
    await expect(readFile(f.p.config)).rejects.toThrow();
  });

  it("doctor diagnoses an empty machine without writing state or prompting when piped", async () => {
    const report = JSON.parse((await f.run(["doctor", "--json"])).stdout);
    expect(report.installations.value).toEqual([]);
    expect(report.profiles.value).toEqual([]);
    expect(report.agents.codex.value).toContain("bin/codex");
    expect(report.globalDefault.state).toBe("missing profile");
    expect((await f.run(["doctor", "--no-prompt"])).stdout).toContain(
      "No aibr-managed browsers installed",
    );
    await f.run(["doctor"]);
    await expect(readdir(f.p.data)).rejects.toThrow();
    await expect(readFile(f.p.config)).rejects.toThrow();
  });

  it("lists adopted profiles, complete launch parameters and damaged profiles together", async () => {
    await f.run([
      "profile",
      "create",
      "external",
      "--user-data-dir",
      join(f.root, "external"),
      "--executable",
      f.browser,
      "--debug-port",
      "0",
      "--media",
      "standard",
      "--headless",
      "--extension",
      join(f.root, "extension"),
      "--chrome-arg=--lang=en",
      "--yes",
      "--default",
    ]);
    const broken = profileDir(f.p, "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "aibr-profile.json"), "{}");
    const list = JSON.parse((await f.run(["profile", "list", "--json"])).stdout);
    expect(list).toHaveLength(2);
    expect(list[0].error).toContain("schemaVersion");
    expect(list[1]).toMatchObject({
      name: "external",
      external: true,
      status: "stopped",
      profile: {
        launch: { headless: true, debugPort: 0, mediaPreset: "standard", extraArgs: ["--lang=en"] },
      },
    });
    const human = (await f.run(["profile", "list"])).stdout;
    expect(human).toContain("external [user default]");
    expect(human).toContain("Extensions:");
    expect(human).toContain("Extra arguments:");
    expect(JSON.parse((await f.run(["profile", "show", "--json"])).stdout).name).toBe("external");
    expect(
      JSON.parse((await f.run(["profile", "show", "--profile", "external", "--json"])).stdout).name,
    ).toBe("external");
    expect(JSON.parse((await f.run(["doctor", "--json"])).stdout).globalDefault.state).toBe(
      "ready",
    );
  });

  it("a missing optional argument opens a chooser only when explicitly requested", async () => {
    await f.run(["profile", "create", "default", "--yes", "--debug-port", "0"]);
    await f.run(["profile", "show"]);
    await expect(f.run(["profile", "show", "--profile"])).rejects.toThrow("interactive terminal");
    await expect(f.run(["explain", "--profile"])).rejects.toThrow("interactive terminal");
    await expect(f.run(["browser", "install"])).rejects.toThrow("interactive terminal");
    await expect(f.run(["browser", "update"])).rejects.toThrow("interactive terminal");
    await expect(
      f.run(["explain", "--profile", "--endpoint", "http://localhost:1"]),
    ).rejects.toThrow("only one");
    await expect(f.run(["profile", "create"])).rejects.toThrow("Supply a profile name");
    vi.spyOn(terminal, "interactive", "get").mockReturnValue(true);
    const choose = vi.spyOn(terminal, "choose").mockResolvedValue("default");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram(f.p).parseAsync(["init", f.root, "--profile"], { from: "user" });
    expect(choose).toHaveBeenCalledOnce();
    expect(await readProject(join(f.root, ".aiui.yaml"))).toBe("default");
  });

  it("reserves distinct saved ports across concurrent external and managed profiles", async () => {
    const [external, managed] = await Promise.all([
      createProfile(f.p, "outside", { dataDir: join(f.root, "outside") }),
      createProfile(f.p, "inside"),
    ]);
    expect(external.profile.launch.debugPort).not.toBe(managed.profile.launch.debugPort);
    expect((await loadConfig(f.p)).targets.outside).toEqual({ dataDir: external.dir });
    expect((await f.run(["profile", "list"])).stdout).toContain("outside");
  });

  it("the install command's omitted family actually installs the chosen family", async () => {
    vi.spyOn(terminal, "interactive", "get").mockReturnValue(true);
    vi.spyOn(terminal, "choose").mockResolvedValue("chrome-for-testing");
    vi.spyOn(terminal, "note").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const install = vi.spyOn(browsers, "installBrowser").mockResolvedValue(f.browser);
    await createProgram(f.p).parseAsync(["browser", "install"], { from: "user" });
    expect(install).toHaveBeenCalledWith(f.p, "chrome-for-testing", undefined);
    const prompt = answers([], ["chromium"]);
    expect(await chooseBrowser(f.p, prompt.ui)).toBe("chromium");
  });

  it("walks through profile settings and directory association before writing", async () => {
    const prompt = answers(
      ["lab", "", "0", join(f.root, "extension"), "", "--lang=en", "", f.root],
      ["local", "chrome-for-testing", false, "standard"],
      [true],
    );
    const result = await setupProfile(f.p, undefined, {}, false, prompt.ui);
    expect(result.profile).toMatchObject({
      name: "lab",
      browser: { managed: "chrome-for-testing" },
      launch: {
        debugPort: 0,
        headless: false,
        mediaPreset: "standard",
        extensions: [{ path: join(f.root, "extension") }],
        extraArgs: ["--lang=en"],
      },
    });
    expect(await readProject(result.project as string)).toBe("lab");
    expect(prompt.texts).toEqual([]);
    expect(prompt.choices).toEqual([]);
    expect(prompt.confirmations).toEqual([]);
    const silent = answers();
    await setupProfile(
      f.p,
      "scripted",
      { yes: true, default: true, debugPort: 0 },
      false,
      silent.ui,
    );
    expect(silent.questions).toEqual([]);
    expect((await loadConfig(f.p)).defaultTarget).toBe("scripted");
  });

  it("cancelling setup leaves no partial profile or project file", async () => {
    const prompt = answers(["cancelled"], ["local", "chromium"]);
    await expect(setupProfile(f.p, undefined, {}, false, prompt.ui)).rejects.toThrow(
      "Unexpected question",
    );
    await expect(readdir(f.p.data)).rejects.toThrow();
    expect(await findProject(f.root)).toBeUndefined();
  });

  it("doctor offers creating a missing default and installing its browser", async () => {
    const prompt = answers(
      ["", "0", "", ""],
      ["local", "chrome-for-testing", false, "standard"],
      [true, false, true],
    );
    const install = vi.spyOn(browsers, "installBrowser").mockImplementation(async (p, family) => {
      await writeJson(join(p.state, `browser-${family}.json`), {
        buildId: "fake",
        executable: f.browser,
      });
      return f.browser;
    });
    expect(await offerSetup(f.p, prompt.ui)).toBe(true);
    expect(install).toHaveBeenCalledWith(f.p, "chrome-for-testing", undefined);
    expect((await readProfile(profileDir(f.p, "default"))).launch.mediaPreset).toBe("standard");
    expect((await diagnose(f.p, f.root)).globalDefault?.state).toBe("ready");
    expect(prompt.confirmations).toEqual([]);
  });

  it("doctor respects declined setup and does not replace a damaged config", async () => {
    expect(await offerSetup(f.p, answers([], [], [false, false]).ui)).toBe(false);
    await expect(readFile(f.p.config)).rejects.toThrow();
    await writeJson(f.p.config, { schemaVersion: 99 });
    expect(await offerSetup(f.p, answers().ui)).toBe(false);
    const report = JSON.parse((await f.run(["doctor", "--json"])).stdout);
    expect(report.config.error).toContain("schemaVersion");
    expect(report.installations.value).toEqual([]);
  });
});

describe("project YAML/JSON selection", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.cleanup();
  });

  it("writes a YAML stub, chooses the nearest format and rejects same-directory ambiguity", async () => {
    await writeProject(f.root, "parent", "json");
    const child = join(f.root, "child");
    await mkdir(child);
    await writeProject(child, "child", "yml");
    expect((await selectTarget(defaultConfig(), {}, child)).label).toBe("child");
    await writeFile(join(child, ".aiui.yaml"), "schemaVersion: 1\nbrowser:\n  target: other\n");
    await expect(selectTarget(defaultConfig(), {}, child)).rejects.toThrow(
      "Multiple project configs",
    );
    expect((await selectTarget(defaultConfig(), { profile: "explicit" }, child)).label).toBe(
      "explicit",
    );
  });

  it.each([
    "schemaVersion: 1\nbrowser: {target: a, target: b}",
    "schemaVersion: 1\nbrowser: {target: a, command: evil}",
    "schemaVersion: 1\nbrowser: {target: !!js/function evil}",
    "schemaVersion: 1\nbrowser: &x {target: *x}",
  ])("rejects malformed or executable-shaped YAML: %s", async (text) => {
    await writeFile(join(f.root, ".aiui.yaml"), text);
    await expect(findProject(f.root)).rejects.toThrow("Cannot read");
  });

  it("init validates names, preserves existing files and supports remote target stubs", async () => {
    await expect(f.run(["init", "--profile", "missing"])).rejects.toThrow("No aibr profile");
    await createProfile(f.p, "research", { debugPort: 0 });
    await f.run(["init", "--profile", "research"]);
    const text = await readFile(join(f.root, ".aiui.yaml"), "utf8");
    expect(text).toContain("target: research");
    await expect(f.run(["init", "--profile", "research", "--format", "json"])).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(join(f.root, ".aiui.yaml"), "utf8")).toBe(text);
    const child = join(f.root, "remote");
    await mkdir(child);
    await updateConfig(f.p, (config) => {
      config.targets.remote = { endpoint: "http://localhost:19222" };
    });
    await f.run(["init", child, "--target", "remote", "--format", "json"]);
    expect((await selectTarget(await loadConfig(f.p), {}, child)).target).toEqual({
      endpoint: "http://localhost:19222",
    });
  });

  it("creates and associates a profile in one command and checks collisions before creating", async () => {
    await f.run(["profile", "create", "project", "--use-here", "--yes", "--debug-port", "0"]);
    expect((await selectTarget(await loadConfig(f.p), {}, f.root)).label).toBe("project");
    await expect(f.run(["profile", "create", "another", "--use-here", "--yes"])).rejects.toThrow(
      "already exists",
    );
    await expect(readProfile(profileDir(f.p, "another"))).rejects.toThrow();
    await expect(
      f.run(["profile", "create", "bad-dir", "--use-here", join(f.root, "missing"), "--yes"]),
    ).rejects.toThrow();
    await expect(readProfile(profileDir(f.p, "bad-dir"))).rejects.toThrow();
  });
});
