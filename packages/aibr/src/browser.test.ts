import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture } from "../test/helpers.ts";
import {
  browserStatus,
  ensureBrowser,
  openUrl,
  readRuntime,
  removeStoppedProfile,
  runtimeFile,
  stopBrowser,
} from "./browser.ts";
import { autoConnection, probeEndpoint } from "./cdp.ts";
import { createProfile, editProfile } from "./profiles.ts";
import { writeJson } from "./storage.ts";

describe("independent browser lifecycle", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const dirs: string[] = [];
  beforeEach(async () => {
    f = await fixture();
    dirs.length = 0;
  });
  afterEach(async () => {
    for (const dir of dirs) {
      try {
        await stopBrowser(f.p, dir);
      } catch {
        /* Already stopped. */
      }
    }
    await f.cleanup();
  });
  async function profile(name: string, debugPort?: number) {
    const result = await createProfile(f.p, name, {
      browser: { executable: f.browser },
      debugPort,
    });
    dirs.push(result.dir);
    return result;
  }
  it("starts a fixed-port browser without DevToolsActivePort and reuses it concurrently", async () => {
    const { dir } = await profile("shared");
    const [a, b] = await Promise.all([ensureBrowser(f.p, dir), ensureBrowser(f.p, dir)]);
    expect(a.wsEndpoint).toBe(b.wsEndpoint);
    expect((await browserStatus(f.p, dir)).state).toBe("running");
    await expect(readFile(join(dir, "DevToolsActivePort"))).rejects.toThrow();
    await openUrl(a, "https://example.com");
    await expect(removeStoppedProfile(f.p, dir)).rejects.toThrow("Close");
    await stopBrowser(f.p, dir);
    expect((await browserStatus(f.p, dir)).state).toBe("stopped");
  });
  it("supports explicit port zero and isolates different profiles", async () => {
    const a = await profile("a", 0);
    const b = await profile("b", 0);
    const [one, two] = await Promise.all([ensureBrowser(f.p, a.dir), ensureBrowser(f.p, b.dir)]);
    expect(one.wsEndpoint).not.toBe(two.wsEndpoint);
    expect(one.autoConnectDir).toBe(a.dir);
    expect((await autoConnection(a.dir)).wsEndpoint).toBe(one.wsEndpoint);
    await stopBrowser(f.p, a.dir);
    expect((await probeEndpoint(two.wsEndpoint)).browserVersion).toBe("Chrome/test");
  });
  it("does not let stale discovery files redirect a fresh browser launch", async () => {
    const a = await profile("a", 0);
    const one = await ensureBrowser(f.p, a.dir);
    const b = await profile("b", 0);
    await writeFile(
      join(b.dir, "DevToolsActivePort"),
      await readFile(join(a.dir, "DevToolsActivePort")),
    );
    const two = await ensureBrowser(f.p, b.dir);
    expect(two.wsEndpoint).not.toBe(one.wsEndpoint);
  });
  it("never attaches to an occupied port of an unverified browser", async () => {
    const a = await profile("a");
    const one = await ensureBrowser(f.p, a.dir);
    const b = await profile("b", 0);
    await editProfile(b.dir, (p) => {
      p.launch.debugPort = a.profile.launch.debugPort;
    });
    await expect(ensureBrowser(f.p, b.dir)).rejects.toThrow("unverified browser");
    expect((await probeEndpoint(one.wsEndpoint)).browserVersion).toBe("Chrome/test");
  });
  it("requires explicit restart after changing launch settings", async () => {
    const { dir } = await profile("a");
    await ensureBrowser(f.p, dir);
    await editProfile(dir, (p) => {
      p.launch.headless = true;
    });
    await expect(ensureBrowser(f.p, dir)).rejects.toThrow("different settings");
    expect((await browserStatus(f.p, dir)).changedSettings).toBe(true);
  });
  it("rejects recycled process identities and leaves the browser untouched", async () => {
    const { dir } = await profile("a");
    const connection = await ensureBrowser(f.p, dir);
    const original = await readRuntime(f.p, await realpath(dir));
    await writeJson(runtimeFile(f.p, dir), { ...original, processIdentity: "old process" });
    await expect(stopBrowser(f.p, dir)).rejects.toThrow("No verified");
    await expect(ensureBrowser(f.p, dir)).rejects.toThrow("in use");
    await probeEndpoint(connection.wsEndpoint);
    await writeJson(runtimeFile(f.p, dir), original);
  });
  it("outlives the launching CLI process and is reused by a later launch", async () => {
    const { dir } = await profile("a");
    const one = JSON.parse((await f.run(["browser", "start", "a"])).stdout);
    expect((await probeEndpoint(one.wsEndpoint)).browserVersion).toBe("Chrome/test");
    const two = JSON.parse((await f.run(["browser", "start", "a"])).stdout);
    expect(two.wsEndpoint).toBe(one.wsEndpoint);
    expect((await browserStatus(f.p, dir)).state).toBe("running");
  });
});
