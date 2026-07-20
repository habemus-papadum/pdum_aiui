/**
 * `aiui profile` — manage browser profiles (docs/proposals/browser-profiles.md).
 *
 *   aiui profile list                 name · browser · size · running?
 *   aiui profile new <name> [...]     create (marker written; immutable after)
 *   aiui profile rm <name>            delete (refuses while its browser runs)
 *   aiui profile adopt <name> [...]   claim a markerless dir for a browser
 *
 * A profile IS a Chrome user-data dir under `~/.cache/aiui/userdata/<name>`;
 * its immutable marker names the browser. `aiui chrome` manages the shared
 * managed BINARIES; profiles reference them. The browser flags (exactly one):
 * `--chromium` | `--cft` | `--channel <c>` | `--executable <path>`.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { discoverSessionBrowser } from "@habemus-papadum/aiui-util";
import { CHROME_CHANNELS, type ChromeChannel } from "../util/config";
import {
  ensureProfileMarker,
  isClaimableProfileDir,
  PROFILE_MARKER,
  type ProfileBrowser,
  profileBrowserLabel,
  profileDir,
  profilesRoot,
  readProfileMarker,
  validateProfileName,
  writeProfileMarker,
} from "../util/profile";
import { printError, printNote } from "../util/ui";

const execFileAsync = promisify(execFile);

export interface ProfileBrowserFlags {
  chromium?: boolean;
  cft?: boolean;
  channel?: string;
  executable?: string;
}

/**
 * The browser a `new`/`adopt` names, from its flags: exactly one, or none
 * (callers decide whether "none" means interview or error). Errors are
 * returned, not thrown — CLI surfaces print them.
 */
export function browserFromFlags(
  flags: ProfileBrowserFlags,
): { browser: ProfileBrowser | undefined } | { error: string } {
  const picked: ProfileBrowser[] = [];
  if (flags.chromium) {
    picked.push({ managed: "chromium" });
  }
  if (flags.cft) {
    picked.push({ managed: "chrome-for-testing" });
  }
  if (flags.channel !== undefined) {
    if (!(CHROME_CHANNELS as readonly string[]).includes(flags.channel)) {
      return {
        error: `unknown Chrome channel "${flags.channel}" — ${CHROME_CHANNELS.join(" | ")}`,
      };
    }
    picked.push({ channel: flags.channel as ChromeChannel });
  }
  if (flags.executable !== undefined) {
    picked.push({ executablePath: flags.executable });
  }
  if (picked.length > 1) {
    return { error: "pick exactly one of --chromium | --cft | --channel | --executable" };
  }
  return { browser: picked[0] };
}

export async function runProfile(
  action: string,
  name: string | undefined,
  flags: ProfileBrowserFlags = {},
): Promise<void> {
  switch (action) {
    case "list":
      await listProfiles();
      return;
    case "new":
      await newProfile(name, flags);
      return;
    case "rm":
      await rmProfile(name);
      return;
    case "adopt":
      adoptProfile(name, flags);
      return;
    default:
      printError(
        action ? `unknown aiui profile action: ${action}` : "aiui profile needs an action",
        "Usage: aiui profile <list | new <name> | rm <name> | adopt <name>>",
      );
      process.exitCode = 1;
  }
}

async function listProfiles(): Promise<void> {
  const root = profilesRoot({ create: false });
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  if (names.length === 0) {
    console.log("no profiles yet — the first launch creates `default` (or `aiui profile new`).");
    return;
  }
  for (const name of names) {
    const dir = profileDir(name);
    const marker = readProfileMarker(dir);
    const running = await discoverSessionBrowser(dir);
    const parts = [
      marker
        ? profileBrowserLabel(marker.browser)
        : `NO ${PROFILE_MARKER} — \`aiui profile adopt\``,
      await dirSize(dir),
      running ? `running (${running.browserUrl})` : "not running",
    ];
    console.log(`${name.padEnd(16)} ${parts.join("  ·  ")}`);
  }
}

/** Human size via `du -sh` (best-effort; blank when unavailable). */
async function dirSize(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("du", ["-sh", dir]);
    return stdout.trim().split(/\s+/)[0] ?? "";
  } catch {
    return "";
  }
}

async function newProfile(name: string | undefined, flags: ProfileBrowserFlags): Promise<void> {
  if (!name) {
    printError("aiui profile new needs a name", "Usage: aiui profile new <name> [--chromium | …]");
    process.exitCode = 1;
    return;
  }
  try {
    validateProfileName(name);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const dir = profileDir(name);
  if (readProfileMarker(dir) !== undefined || !isClaimableProfileDir(dir)) {
    printError(
      `profile "${name}" already exists (${dir})`,
      "A profile's browser is immutable — create a different name for a different browser.",
    );
    process.exitCode = 1;
    return;
  }
  const picked = browserFromFlags(flags);
  if ("error" in picked) {
    printError(picked.error);
    process.exitCode = 1;
    return;
  }
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const marker = picked.browser
    ? writeProfileMarker(dir, picked.browser)
    : await ensureProfileMarker(dir, { interactive, profileName: name });
  printNote(`created profile "${name}" — ${profileBrowserLabel(marker.browser)}`, dir);
}

async function rmProfile(name: string | undefined): Promise<void> {
  if (!name) {
    printError("aiui profile rm needs a name", "Usage: aiui profile rm <name>");
    process.exitCode = 1;
    return;
  }
  const dir = profileDir(name);
  if (!existsSync(dir)) {
    printError(`no profile "${name}" (${dir})`);
    process.exitCode = 1;
    return;
  }
  const running = await discoverSessionBrowser(dir);
  if (running) {
    printError(
      `profile "${name}" has a running browser (${running.browserUrl})`,
      "Close that window first, then rerun.",
    );
    process.exitCode = 1;
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  printNote(`removed profile "${name}"`, dir);
}

function adoptProfile(name: string | undefined, flags: ProfileBrowserFlags): void {
  if (!name) {
    printError(
      "aiui profile adopt needs a name",
      "Usage: aiui profile adopt <name> --chromium (or --cft | --channel | --executable)",
    );
    process.exitCode = 1;
    return;
  }
  const dir = profileDir(name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    printError(`no directory to adopt at ${dir}`, "Adoption claims an EXISTING markerless dir.");
    process.exitCode = 1;
    return;
  }
  if (readProfileMarker(dir) !== undefined) {
    printError(`profile "${name}" already has a marker — nothing to adopt`);
    process.exitCode = 1;
    return;
  }
  const picked = browserFromFlags(flags);
  if ("error" in picked) {
    printError(picked.error);
    process.exitCode = 1;
    return;
  }
  if (!picked.browser) {
    // Never guess which browser owns unknown profile data — that's the whole
    // reason adoption is explicit.
    printError(
      "adopt needs the browser named explicitly",
      "Pass exactly one of --chromium | --cft | --channel <c> | --executable <path>.",
    );
    process.exitCode = 1;
    return;
  }
  const marker = writeProfileMarker(dir, picked.browser);
  printNote(`adopted "${name}" — ${profileBrowserLabel(marker.browser)}`, dir);
}
