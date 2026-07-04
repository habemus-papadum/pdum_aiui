/**
 * aiui's two-level configuration file.
 *
 * Settings live in `config.json` at up to two places, merged per-key with the
 * more specific one winning:
 *
 *   <user cache>/config.json          e.g. ~/.cache/aiui/config.json (respects
 *                                     AIUI_CACHE / XDG_CACHE_HOME)
 *   <project>/.aiui-cache/config.json  next to the traces and Chrome profiles
 *
 * CLI flags override both. Everything is optional; a missing file is an empty
 * config. A *malformed* file is a hard error, not a warning — these settings
 * gate security-relevant behavior (`claude.skipPermissions`), and a typo that
 * silently reverts to the dangerous default is worse than a failed launch. The
 * same reasoning rejects unknown keys.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectCacheDir } from "@habemus-papadum/aiui-claude-channel";
import { cacheDir } from "@habemus-papadum/aiui-util";

export const CONFIG_FILENAME = "config.json";

export const CHROME_CHANNELS = ["stable", "beta", "dev", "canary"] as const;
export type ChromeChannel = (typeof CHROME_CHANNELS)[number];

export const FOR_TESTING_MODES = ["prompt", "auto", "off"] as const;
export type ForTestingMode = (typeof FOR_TESTING_MODES)[number];

export const CHROME_MODES = ["attach", "launch"] as const;
export type ChromeMode = (typeof CHROME_MODES)[number];

export interface AiuiConfig {
  claude?: {
    /**
     * Launch Claude Code with `--dangerously-skip-permissions`. A personal
     * preference with real consequences (see docs/guide/warning) — the first
     * interactive launch asks and persists the answer here; when unset in a
     * non-interactive session it defaults to true.
     */
    skipPermissions?: boolean;
    /**
     * Auto-dismiss Claude Code's development-channel acknowledgement prompt
     * by injecting an Enter keypress into the terminal at startup (see
     * util/enter-nudge.ts). Chosen on first interactive run; defaults to true
     * when unset.
     */
    enterNudge?: boolean;
  };
  chrome?: {
    /**
     * Attach the Chrome DevTools MCP (default: true). `false` turns it off
     * everywhere; `true` does not override the CI default-off — only the
     * `--aiui-chrome` flag forces it on under CI.
     */
    enabled?: boolean;
    /**
     * How the MCP reaches a browser (default: "attach"). `"attach"` shares a
     * user-visible session browser: an already-running one is discovered by
     * profile, or an interactive launch starts one eagerly. `"launch"` is the
     * hands-off mode: chrome-devtools-mcp launches its own private browser
     * lazily, on the agent's first browser tool call.
     */
    mode?: ChromeMode;
    /**
     * Attach to this Chrome DevTools endpoint (e.g. "http://127.0.0.1:9222")
     * instead of managing a browser at all — the remote-development key: the
     * browser runs on another machine (started there with `aiui browser`) and
     * its port is tunneled over. Setting it implies `mode: "attach"` and makes
     * every local-browser setting (profile, executablePath, channel,
     * forTesting…) irrelevant.
     */
    browserUrl?: string;
    /**
     * Fixed DevTools debug port for session browsers aiui launches
     * (default: 0 — an OS-assigned free port). Pin it (e.g. 9222) when
     * something else must find the port, like an ssh tunnel.
     */
    debugPort?: number;
    /** Named profile under `.aiui-cache/chrome/` (default: "default"). */
    profile?: string;
    /** Explicit Chrome user data dir; takes precedence over `profile`. */
    dataDir?: string;
    /**
     * Chrome binary to launch — e.g. a Chrome for Testing install, which
     * still honors `--load-extension`. Mutually exclusive with `channel`.
     */
    executablePath?: string;
    /** Installed Chrome release channel to launch (default: stable). */
    channel?: ChromeChannel;
    /**
     * How `aiui claude` manages Chrome for Testing, the recommended browser
     * (default: "prompt"). `"prompt"` asks before installing or updating it —
     * interactive sessions only, never under CI; `"auto"` installs/updates
     * without asking; `"off"` never checks. Skipped entirely when
     * `executablePath` or `channel` picks a browser explicitly.
     */
    forTesting?: ForTestingMode;
    /** Launch Chrome headless (default: false). */
    headless?: boolean;
    /**
     * In a dev checkout, rebuild the aiui-devtools-extension package (~0.3s of tsc)
     * on every launch so the auto-loaded panel is never stale (default: true).
     */
    buildExtension?: boolean;
  };
}

/** The `config.json` paths consulted, user-level first (base: the project dir). */
export function configPaths(base: string = process.cwd()): { user: string; project: string } {
  return {
    user: join(cacheDir(undefined, { create: false }), CONFIG_FILENAME),
    project: join(projectCacheDir(base), CONFIG_FILENAME),
  };
}

/** Load and merge the user- and project-level configs (project wins per key). */
export function loadAiuiConfig(base: string = process.cwd()): AiuiConfig {
  const paths = configPaths(base);
  return mergeAiuiConfig(readConfigFile(paths.user) ?? {}, readConfigFile(paths.project) ?? {});
}

/** Merge two configs section-by-section; `override`'s keys win within a section. */
export function mergeAiuiConfig(base: AiuiConfig, override: AiuiConfig): AiuiConfig {
  return {
    claude: { ...base.claude, ...override.claude },
    chrome: { ...base.chrome, ...override.chrome },
  };
}

/**
 * Read one config file. Missing → undefined; unreadable JSON or an unexpected
 * shape → an error naming the file, so the fix is obvious.
 */
export function readConfigFile(file: string): AiuiConfig | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateConfig(raw, file);
}

function validateConfig(raw: unknown, file: string): AiuiConfig {
  const root = asSection(raw, file, "the top level");
  rejectUnknownKeys(root, ["claude", "chrome"], file, "the top level");

  const config: AiuiConfig = {};
  if (root.claude !== undefined) {
    const claude = asSection(root.claude, file, `"claude"`);
    rejectUnknownKeys(claude, ["skipPermissions", "enterNudge"], file, `"claude"`);
    // prune: absent keys must stay absent, or the merge spread would let an
    // explicit `undefined` here clobber a value from the other config level.
    config.claude = prune({
      skipPermissions: asOptional(
        claude.skipPermissions,
        "boolean",
        file,
        "claude.skipPermissions",
      ),
      enterNudge: asOptional(claude.enterNudge, "boolean", file, "claude.enterNudge"),
    });
  }
  if (root.chrome !== undefined) {
    const chrome = asSection(root.chrome, file, `"chrome"`);
    rejectUnknownKeys(
      chrome,
      [
        "enabled",
        "mode",
        "browserUrl",
        "debugPort",
        "profile",
        "dataDir",
        "executablePath",
        "channel",
        "forTesting",
        "headless",
        "buildExtension",
      ],
      file,
      `"chrome"`,
    );
    const channel = asOptional(chrome.channel, "string", file, "chrome.channel");
    if (channel !== undefined && !(CHROME_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(
        `invalid chrome.channel "${channel}" in ${file} — expected one of: ${CHROME_CHANNELS.join(", ")}`,
      );
    }
    const forTesting = asOptional(chrome.forTesting, "string", file, "chrome.forTesting");
    if (
      forTesting !== undefined &&
      !(FOR_TESTING_MODES as readonly string[]).includes(forTesting)
    ) {
      throw new Error(
        `invalid chrome.forTesting "${forTesting}" in ${file} — expected one of: ${FOR_TESTING_MODES.join(", ")}`,
      );
    }
    const mode = asOptional(chrome.mode, "string", file, "chrome.mode");
    if (mode !== undefined && !(CHROME_MODES as readonly string[]).includes(mode)) {
      throw new Error(
        `invalid chrome.mode "${mode}" in ${file} — expected one of: ${CHROME_MODES.join(", ")}`,
      );
    }
    const browserUrl = asOptional(chrome.browserUrl, "string", file, "chrome.browserUrl");
    if (browserUrl !== undefined && !isHttpUrl(browserUrl)) {
      throw new Error(
        `invalid chrome.browserUrl "${browserUrl}" in ${file} — expected an http(s) URL like "http://127.0.0.1:9222"`,
      );
    }
    const debugPort = asOptional(chrome.debugPort, "number", file, "chrome.debugPort");
    if (
      debugPort !== undefined &&
      !(Number.isInteger(debugPort) && debugPort >= 0 && debugPort <= 65535)
    ) {
      throw new Error(`invalid chrome.debugPort ${debugPort} in ${file} — expected 0..65535`);
    }
    config.chrome = prune({
      enabled: asOptional(chrome.enabled, "boolean", file, "chrome.enabled"),
      mode: mode as ChromeMode | undefined,
      browserUrl,
      debugPort,
      profile: asOptional(chrome.profile, "string", file, "chrome.profile"),
      dataDir: asOptional(chrome.dataDir, "string", file, "chrome.dataDir"),
      executablePath: asOptional(chrome.executablePath, "string", file, "chrome.executablePath"),
      channel: channel as ChromeChannel | undefined,
      forTesting: forTesting as ForTestingMode | undefined,
      headless: asOptional(chrome.headless, "boolean", file, "chrome.headless"),
      buildExtension: asOptional(chrome.buildExtension, "boolean", file, "chrome.buildExtension"),
    });
  }
  return config;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Persist a change to the **user-level** config (creating the file if needed).
 *
 * This is how interactive prompt answers like "never ask again" become
 * durable: they are per-user decisions, so they land in the user cache — never
 * in the project file, which may be shared/committed by a team.
 */
export function updateUserConfig(mutate: (config: AiuiConfig) => void): string {
  const file = configPaths().user;
  const config = readConfigFile(file) ?? {};
  mutate(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** Drop `undefined`-valued keys so merging can't see them as overrides. */
function prune<T extends Record<string, unknown>>(section: T): T {
  return Object.fromEntries(Object.entries(section).filter(([, v]) => v !== undefined)) as T;
}

function asSection(value: unknown, file: string, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object at ${where} of ${file}`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  section: Record<string, unknown>,
  known: string[],
  file: string,
  where: string,
): void {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) {
      throw new Error(
        `unknown key "${key}" at ${where} of ${file} — known keys: ${known.join(", ")}`,
      );
    }
  }
}

function asOptional<T extends "boolean" | "string" | "number">(
  value: unknown,
  type: T,
  file: string,
  where: string,
): (T extends "boolean" ? boolean : T extends "number" ? number : string) | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== type) {
    throw new Error(`expected a ${type} for ${where} in ${file}`);
  }
  return value as T extends "boolean" ? boolean : T extends "number" ? number : string;
}
