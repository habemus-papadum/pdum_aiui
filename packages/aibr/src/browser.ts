import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { autoConnection, cdp, probeEndpoint } from "./cdp.ts";
import { browserExecutable } from "./installations.ts";
import {
  type Connection,
  DEVELOPMENT_MEDIA_ARGS,
  type ExtensionSpec,
  object,
  type Paths,
  type Profile,
  type Runtime,
  string,
} from "./model.ts";
import { portAvailable, readProfile, removeProfileData } from "./profiles.ts";
import { locked, readJson, writeJson } from "./storage.ts";

const run = promisify(execFile);

export async function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  try {
    const { stdout } = await run(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      { timeout: 2000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function runtimeFile(p: Paths, dir: string): string {
  const hash = createHash("sha256").update(dir).digest("hex");
  return join(p.state, "browsers", `${hash}.json`);
}

export async function readRuntime(p: Paths, dir: string): Promise<Runtime | undefined> {
  const raw = await readJson(runtimeFile(p, dir));
  if (raw === undefined) return undefined;
  const record = object(raw, "Browser runtime record");
  if (
    record.schemaVersion !== 1 ||
    typeof record.pid !== "number" ||
    typeof record.profileId !== "string" ||
    typeof record.processIdentity !== "string"
  ) {
    throw new Error(`Invalid browser runtime record: ${runtimeFile(p, dir)}`);
  }
  const connection = object(record.connection, "Runtime connection");
  string(connection.wsEndpoint, "Runtime WebSocket endpoint");
  return raw as Runtime;
}

async function liveRuntime(p: Paths, dir: string, profile: Profile): Promise<Runtime | undefined> {
  const runtime = await readRuntime(p, dir);
  if (!runtime || runtime.profileId !== profile.id) return undefined;
  if ((await processIdentity(runtime.pid)) !== runtime.processIdentity) return undefined;
  // Query the exact browser instance, not just a port another browser may have reused.
  await probeEndpoint(runtime.connection.wsEndpoint);
  return runtime;
}

export async function extensionDirectory(spec: ExtensionSpec, dataDir: string): Promise<string> {
  let dir: string;
  if ("path" in spec) {
    if (!isAbsolute(spec.path)) throw new Error("Extension paths must be absolute");
    dir = spec.path;
  } else {
    const req = createRequire(join(dataDir, "package.json"));
    const own = createRequire(import.meta.url);
    let root: string | undefined;
    for (const resolver of [req, own]) {
      try {
        root = dirname(resolver.resolve(`${spec.package}/package.json`));
        break;
      } catch {
        try {
          let candidate = dirname(resolver.resolve(spec.package));
          while (true) {
            const manifest = await readJson(join(candidate, "package.json"));
            if (manifest && object(manifest, "Package manifest").name === spec.package) {
              root = candidate;
              break;
            }
            const parent = dirname(candidate);
            if (parent === candidate) break;
            candidate = parent;
          }
        } catch {
          /* Try the launcher's installed dependency tree next. */
        }
      }
      if (root) break;
    }
    if (!root)
      throw new Error(
        `Cannot resolve extension package ${spec.package}; use an absolute extension path`,
      );
    dir = resolve(root, spec.directory);
  }
  dir = await realpath(dir);
  if (dir.includes(","))
    throw new Error("Chrome cannot load an extension directory containing a comma");
  const raw = await readJson(join(dir, "manifest.json"));
  if (!raw)
    throw new Error(`Missing extension manifest in ${dir}; build the extension before launching`);
  const manifest = object(raw, "Extension manifest");
  if (![2, 3].includes(Number(manifest.manifest_version)))
    throw new Error(`Invalid extension manifest in ${dir}`);
  const background = manifest.background ? object(manifest.background, "Extension background") : {};
  const scripts: unknown[] = [background.service_worker];
  if (Array.isArray(background.scripts)) scripts.push(...background.scripts);
  if (Array.isArray(manifest.content_scripts)) {
    for (const content of manifest.content_scripts) {
      const entry = object(content, "Extension content script");
      if (Array.isArray(entry.js)) scripts.push(...entry.js);
    }
  }
  for (const script of scripts)
    if (script !== undefined) await access(join(dir, string(script, "Extension script")));
  return dir;
}

export function browserArgs(profile: Profile, dir: string, extensions: string[]): string[] {
  return [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${profile.launch.debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(profile.launch.mediaPreset === "development" ? DEVELOPMENT_MEDIA_ARGS : []),
    ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []),
    ...(profile.launch.headless ? ["--headless"] : []),
    ...profile.launch.extraArgs,
    "about:blank",
  ];
}

export interface BrowserStatus {
  state: "stopped" | "running" | "unreachable";
  runtime?: Runtime;
  changedSettings?: boolean;
  detail?: string;
}

export async function browserStatus(p: Paths, inputDir: string): Promise<BrowserStatus> {
  const dir = await realpath(inputDir);
  const profile = await readProfile(dir);
  try {
    const runtime = await liveRuntime(p, dir, profile);
    return runtime
      ? {
          state: "running",
          runtime,
          changedSettings: JSON.stringify(runtime.launch) !== JSON.stringify(profile.launch),
        }
      : { state: "stopped" };
  } catch (error) {
    return { state: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function ensureBrowser(
  p: Paths,
  inputDir: string,
  overrides: { headless?: boolean } = {},
): Promise<Connection> {
  const dir = await realpath(inputDir);
  return locked(runtimeFile(p, dir), async () => {
    const profile = await readProfile(dir);
    if (overrides.headless !== undefined) profile.launch.headless = overrides.headless;
    const current = await liveRuntime(p, dir, profile);
    if (current) {
      if (JSON.stringify(current.launch) !== JSON.stringify(profile.launch)) {
        throw new Error(
          `Browser is running with different settings. Close it explicitly with aibr browser stop --user-data-dir ${dir}, then start it again.`,
        );
      }
      return current.connection;
    }
    if (profile.launch.debugPort && !(await portAvailable(profile.launch.debugPort))) {
      throw new Error(
        `Port ${profile.launch.debugPort} is in use; refusing to attach to an unverified browser or change the saved port`,
      );
    }
    const executable = await browserExecutable(p, profile.browser);
    const extensions = await Promise.all(
      profile.launch.extensions.map((ext) => extensionDirectory(ext, dir)),
    );
    const logPath = join(p.state, "logs", `${profile.id}.log`);
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    const log = await open(logPath, "a", 0o600);
    const logOffset = (await log.stat()).size;
    // Do not remove DevToolsActivePort: an externally launched browser may own it.
    // Freshness is established by the spawned process identity and browser instance.
    const child = spawn(executable, browserArgs(profile, dir, extensions), {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    try {
      await once(child, "spawn");
    } finally {
      await log.close();
    }
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error("Browser did not provide a process ID");
    const deadline = Date.now() + 20_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (exited)
        throw new Error(
          `Browser exited before exposing CDP. Another browser may already own this profile; check ${logPath}`,
        );
      try {
        // Use the browser instance announced by THIS launch, so a stale port file
        // or a different process winning a port race cannot be mistaken for ours.
        const reader = await open(logPath, "r");
        let launchLog: string;
        try {
          const buffer = Buffer.alloc(256 * 1024);
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, logOffset);
          launchLog = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await reader.close();
        }
        const ws = launchLog.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
        if (!ws) throw new Error("Waiting for the browser's DevTools endpoint announcement");
        const connection = await probeEndpoint(ws, 1000);
        connection.endpoint = `http://127.0.0.1:${new URL(ws).port}`;
        if (profile.launch.debugPort && Number(new URL(ws).port) !== profile.launch.debugPort)
          throw new Error("Browser did not bind the saved debug port");
        if (!profile.launch.debugPort) {
          const discovered = await autoConnection(dir);
          if (discovered.wsEndpoint !== connection.wsEndpoint)
            throw new Error("DevToolsActivePort does not match this browser instance");
          connection.autoConnectDir = dir;
        }
        // Chrome hands a second launch to the existing profile process and exits.
        // Give that handoff time to complete before claiming a successful launch.
        await delay(150);
        // A caller-supplied executable can be an exec'ing shell script. Record
        // the final process identity only after its browser endpoint is ready.
        const identity = await processIdentity(pid);
        if (exited || !identity)
          throw new Error("Browser process exited or changed during startup");
        const runtime: Runtime = {
          schemaVersion: 1,
          profileId: profile.id,
          pid,
          processIdentity: identity,
          executable,
          startedAt: new Date().toISOString(),
          launch: profile.launch,
          connection,
        };
        await writeJson(runtimeFile(p, dir), runtime);
        return connection;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    if (!exited) child.kill("SIGTERM");
    throw new Error(
      `Browser did not expose CDP; check ${logPath}. ${lastError instanceof Error ? lastError.message : ""}`,
    );
  });
}

export async function stopBrowser(p: Paths, inputDir: string): Promise<void> {
  const dir = await realpath(inputDir);
  await locked(runtimeFile(p, dir), async () => {
    const runtime = await liveRuntime(p, dir, await readProfile(dir));
    if (!runtime) throw new Error("No verified aibr browser is running for this profile");
    await cdp(runtime.connection.wsEndpoint, "Browser.close");
    const deadline = Date.now() + 5000;
    while ((await processIdentity(runtime.pid)) === runtime.processIdentity) {
      if (Date.now() > deadline)
        throw new Error("Browser has not exited yet; no force-kill was sent");
      await delay(100);
    }
    await rm(runtimeFile(p, dir), { force: true });
  });
}

export async function openUrl(connection: Connection, url: string): Promise<void> {
  new URL(url);
  await cdp(connection.wsEndpoint, "Target.createTarget", { url });
}

export async function removeStoppedProfile(p: Paths, inputDir: string): Promise<void> {
  const dir = await realpath(inputDir);
  await locked(runtimeFile(p, dir), async () => {
    if ((await browserStatus(p, dir)).state !== "stopped")
      throw new Error("Close the profile's browser before removing its data");
    try {
      await lstat(join(dir, "SingletonLock"));
      throw new Error(
        "Profile has a Chrome SingletonLock; close Chrome and resolve stale locks before removing it",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await removeProfileData(dir);
    await rm(runtimeFile(p, dir), { force: true });
  });
}
