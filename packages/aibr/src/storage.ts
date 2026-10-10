import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { Paths } from "./model.ts";

export function paths(env = process.env, home = homedir(), platform = process.platform): Paths {
  if (env.AIBR_HOME) {
    const root = resolve(env.AIBR_HOME);
    return {
      config: join(root, "config.json"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      state: join(root, "state"),
    };
  }
  if (platform === "darwin") {
    const data = join(home, "Library", "Application Support", "aibr");
    return {
      config: join(data, "config.json"),
      data,
      state: join(data, "state"),
      cache: join(home, "Library", "Caches", "aibr"),
    };
  }
  return {
    config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "aibr", "config.json"),
    data: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "aibr"),
    state: join(env.XDG_STATE_HOME || join(home, ".local", "state"), "aibr"),
    cache: join(env.XDG_CACHE_HOME || join(home, ".cache"), "aibr"),
  };
}

export async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Short-lived filesystem locks, with heartbeat and stale-owner recovery. Never inherited across exec. */
export async function locked<T>(file: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: { retries: 150, minTimeout: 100, maxTimeout: 200, factor: 1 },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  try {
    const result = await action();
    if (compromised) throw compromised;
    return result;
  } finally {
    await release();
  }
}
