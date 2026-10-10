import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig, namedTarget, updateConfig } from "./config.ts";
import {
  type BrowserSpec,
  type Config,
  endpoint,
  name,
  type Paths,
  type Profile,
  parseProfile,
  type Target,
} from "./model.ts";
import { locked, readJson, writeJson } from "./storage.ts";

export const PROFILE_FILE = "aibr-profile.json";
export const profileDir = (p: Paths, key: string): string => join(p.data, "profiles", name(key));
export const profileFile = (dir: string): string => join(dir, PROFILE_FILE);

export function namedProfileDir(p: Paths, key: string, config: Config): string {
  const target = namedTarget(config, key);
  if ("dataDir" in target) return target.dataDir;
  if ("profile" in target) return profileDir(p, target.profile);
  throw new Error(`Profile ${key} is remote; its browser lifecycle is managed on the browser host`);
}

export interface ProfileRow {
  name: string;
  dir?: string;
  external: boolean;
  target: Target;
  profile?: Profile;
  error?: string;
}

/** Inventory includes adopted directories and keeps damaged entries visible for diagnosis. */
export async function inspectProfiles(p: Paths, config: Config): Promise<ProfileRow[]> {
  const candidates = new Set<string>();
  try {
    for (const entry of await readdir(join(p.data, "profiles"), { withFileTypes: true }))
      if (entry.isDirectory()) candidates.add(entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const key of Object.keys(config.targets)) candidates.add(key);
  return Promise.all(
    [...candidates]
      .sort((a, b) => a.localeCompare(b))
      .map(async (key): Promise<ProfileRow> => {
        let target: Target = { profile: key };
        let dir: string | undefined;
        try {
          target = namedTarget(config, key);
          if ("endpoint" in target || "provider" in target)
            return { name: key, target, external: true };
          dir = namedProfileDir(p, key, config);
          return {
            name: key,
            dir,
            target,
            external: "dataDir" in target,
            profile: await readProfile(dir),
          };
        } catch (error) {
          return {
            name: key,
            dir,
            target,
            external: "dataDir" in target,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
  );
}

export async function createEndpointProfile(p: Paths, key: string, url: string): Promise<void> {
  name(key);
  const value = endpoint(url);
  await locked(join(p.state, "profiles"), async () => {
    try {
      await lstat(profileDir(p, key));
      throw new Error(`Profile ${key} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await updateConfig(p, (config) => {
      if (Object.hasOwn(config.targets, key)) throw new Error(`Profile ${key} already exists`);
      config.targets[key] = { endpoint: value };
    });
  });
}

export async function readProfile(dir: string): Promise<Profile> {
  const raw = await readJson(profileFile(dir));
  if (raw === undefined)
    throw new Error(
      `No aibr profile in ${dir}. Use aibr profile create, or profile adopt for an existing directory.`,
    );
  const profile = parseProfile(raw);
  if ("executable" in profile.browser && !isAbsolute(profile.browser.executable))
    throw new Error("Profile browser executable must be absolute");
  return profile;
}

export async function listProfiles(p: Paths): Promise<Array<{ dir: string; profile: Profile }>> {
  const root = join(p.data, "profiles");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    rows.push({ dir, profile: await readProfile(dir) });
  }
  return rows;
}

export async function portAvailable(n: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(n, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}

export async function createProfile(
  p: Paths,
  key: string,
  options: {
    browser?: BrowserSpec;
    debugPort?: number;
    headless?: boolean;
    mediaPreset?: "standard" | "development";
    extensions?: string[];
    extraArgs?: string[];
    dataDir?: string;
    adopt?: boolean;
  } = {},
): Promise<{ dir: string; profile: Profile }> {
  name(key);
  return locked(join(p.state, "profiles"), async () => {
    const config = await loadConfig(p);
    if (Object.hasOwn(config.targets, key))
      throw new Error(`A saved target named ${key} already exists; choose another profile name`);
    const dir = options.dataDir ? resolve(options.dataDir) : profileDir(p, key);
    if ((await readJson(profileFile(dir))) !== undefined)
      throw new Error(`Profile already exists in ${dir}`);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entries.length && !options.adopt)
      throw new Error(
        "Directory is not empty; use profile adopt to explicitly associate its existing state with a browser",
      );
    const used = new Set(
      (await inspectProfiles(p, config)).flatMap((row) =>
        row.profile ? [row.profile.launch.debugPort] : [],
      ),
    );
    let debugPort = options.debugPort;
    if (debugPort === undefined) {
      debugPort = 9222;
      while (debugPort <= 65535 && (used.has(debugPort) || !(await portAvailable(debugPort))))
        debugPort++;
    } else if (debugPort !== 0 && (used.has(debugPort) || !(await portAvailable(debugPort)))) {
      throw new Error(`Port ${debugPort} is already assigned or in use`);
    }
    const profile = parseProfile({
      schemaVersion: 1,
      id: randomUUID(),
      name: key,
      browser: options.browser ?? { managed: "chromium" },
      launch: {
        debugPort,
        headless: options.headless ?? false,
        mediaPreset: options.mediaPreset ?? "development",
        extensions: (options.extensions ?? []).map((path) => ({ path: resolve(path) })),
        extraArgs: options.extraArgs ?? [],
      },
    });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJson(profileFile(dir), profile);
    const canonicalDir = await realpath(dir);
    if (options.dataDir)
      await updateConfig(p, (value) => {
        value.targets[key] = { dataDir: canonicalDir };
      });
    return { dir: canonicalDir, profile };
  });
}

export async function editProfile(dir: string, edit: (p: Profile) => void): Promise<Profile> {
  return locked(profileFile(dir), async () => {
    const profile = await readProfile(dir);
    const browser = JSON.stringify(profile.browser);
    const id = profile.id;
    edit(profile);
    if (browser !== JSON.stringify(profile.browser) || profile.id !== id)
      throw new Error("A profile's browser family and identity cannot change");
    const updated = parseProfile(profile);
    await writeJson(profileFile(dir), updated);
    return updated;
  });
}

/** Removal is called only after the CLI verifies that the profile has no live browser. */
export async function removeProfileData(dir: string): Promise<void> {
  await readProfile(dir);
  await rm(dir, { recursive: true });
}
