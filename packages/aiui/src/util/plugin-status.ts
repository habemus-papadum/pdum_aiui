import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { packageRoot } from "./resolve-cli";
import { printError, printNote, printWarning } from "./ui";
import { VERSION } from "./version";

// The repo-root Claude plugin (.claude-plugin/plugin.json + skills/) is a
// launch precondition of `aiui claude`: without it the session has none of the
// aiui skills, which the rest of the tooling assumes are present. How it is
// found depends on provenance (the same source/installed split the vendor keys
// use — see util/keys-interview's keysMode):
//
//  - source checkout: the working tree IS the plugin. It rides along as
//    `--plugin-dir <repo root>`, which is session-scoped and takes precedence
//    over any marketplace-installed copy of the same plugin name — so a dev
//    checkout always runs its own skills.
//  - installed from npm: the plugin arrives separately, installed once from
//    the repo's git marketplace (`claude plugin marketplace add` + `claude
//    plugin install`) and loaded by Claude Code itself at user scope. Here we
//    only VERIFY: refuse to launch when it is absent or disabled, and warn
//    loudly when its version has fallen behind this CLI (the plugin manifest
//    is lockstep-versioned, so base versions are directly comparable).

/** The plugin's name in its manifest — what `claude plugin list` ids start with. */
const PLUGIN_NAME = "aiui";
/** The marketplace source and name users install from (the repo itself). */
const MARKETPLACE_SOURCE = "habemus-papadum/pdum_aiui";
const MARKETPLACE_NAME = "pdum-aiui";

const INSTALL_COMMANDS =
  `  claude plugin marketplace add ${MARKETPLACE_SOURCE}\n` +
  `  claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** One entry of `claude plugin list --json` (the fields this check reads). */
export interface PluginListEntry {
  id?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  projectPath?: string;
}

/**
 * Classify the aiui plugin's install state for a project, from the full
 * `plugin list --json` output. Entries are matched by plugin NAME (any
 * marketplace counts — the version rides the plugin manifest regardless of
 * which catalog delivered it), and project-scoped rows count only for their
 * own project.
 */
export function classifyInstalled(
  entries: PluginListEntry[],
  cwd: string,
): { state: "absent" } | { state: "disabled" | "enabled"; entry: PluginListEntry } {
  const candidates = entries.filter(
    (entry) =>
      entry.id?.startsWith(`${PLUGIN_NAME}@`) &&
      (entry.projectPath === undefined || resolve(entry.projectPath) === resolve(cwd)),
  );
  const active = candidates.find((entry) => entry.enabled);
  if (active !== undefined) {
    return { state: "enabled", entry: active };
  }
  return candidates.length > 0 ? { state: "disabled", entry: candidates[0] } : { state: "absent" };
}

/**
 * How the installed plugin's version relates to this CLI's, comparing semver
 * cores (`0.17.0+dev` → 0.17.0 — the lockstep `+dev` marker never separates a
 * git install from the npm release it corresponds to).
 */
export function versionRelation(
  pluginVersion: string | undefined,
  cliVersion: string,
): "stale" | "current" | "newer" | "unknown" {
  const plugin = baseVersion(pluginVersion);
  const cli = baseVersion(cliVersion);
  if (plugin === undefined || cli === undefined) {
    return "unknown";
  }
  const order = compareBase(plugin, cli);
  return order < 0 ? "stale" : order > 0 ? "newer" : "current";
}

/**
 * The repo root holding the plugin manifest, walking up from this package
 * (packages/aiui → the checkout root). Only meaningful in source mode; an
 * installed aiui has no repo above it and gets undefined.
 */
export function sourcePluginRoot(): string | undefined {
  let dir = packageRoot("@habemus-papadum/aiui");
  let parent = dirname(dir);
  while (dir !== parent) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) {
      return dir;
    }
    dir = parent;
    parent = dirname(dir);
  }
  return undefined;
}

/** `X.Y.Z` prefix as numbers (`0.17.0+dev` → [0,17,0]), or undefined. */
function baseVersion(version: string | undefined): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareBase(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Resolve the aiui plugin for this launch, printing any refusal/warning.
 *
 * Returns the `--plugin-dir` values to pass (one dir in source mode, none when
 * installed — Claude Code loads the marketplace-installed plugin itself), or
 * undefined to refuse the launch (the message is already printed and the exit
 * code set).
 */
export async function ensureAiuiPlugin(
  mode: "source" | "installed",
  cwd: string = process.cwd(),
): Promise<string[] | undefined> {
  if (mode === "source") {
    const root = sourcePluginRoot();
    if (root === undefined) {
      printError(
        "this source checkout is missing its repo-root plugin — refusing to launch",
        `Expected .claude-plugin/plugin.json in a directory above ${packageRoot("@habemus-papadum/aiui")}.\n` +
          "The aiui skills live there; restore it (git checkout .claude-plugin skills) and relaunch.",
      );
      process.exitCode = 1;
      return undefined;
    }
    return [root];
  }

  // Installed: ask Claude Code what is installed. `plugin list --json` reports
  // every scope with projectPath on project-scoped rows, so filter to entries
  // that apply HERE: machine-wide ones, or project ones for this cwd.
  const result = await execa("claude", ["plugin", "list", "--json"], { cwd, reject: false });
  let entries: PluginListEntry[] | undefined;
  if (result.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      entries = Array.isArray(parsed) ? (parsed as PluginListEntry[]) : undefined;
    } catch {
      // fall through to the enumeration error below
    }
  }
  if (entries === undefined) {
    printError(
      "couldn't enumerate Claude plugins — refusing to launch",
      "aiui claude verifies its plugin via `claude plugin list --json`, which failed:\n" +
        `  ${(result.stderr || result.stdout || "(no output)").trim().split("\n")[0]}\n` +
        "If your Claude Code predates the plugin CLI, update it and relaunch.",
    );
    process.exitCode = 1;
    return undefined;
  }

  const status = classifyInstalled(entries, cwd);
  if (status.state === "disabled") {
    printError(
      "the aiui Claude plugin is installed but disabled — refusing to launch",
      `The session's skills come from it. Re-enable and relaunch:\n\n  claude plugin enable ${status.entry.id}`,
    );
    process.exitCode = 1;
    return undefined;
  }
  if (status.state === "absent") {
    printError(
      "the aiui Claude plugin is not installed — refusing to launch",
      "The session's skills come from the repo's plugin marketplace; install once " +
        `(both commands are safe to re-run), then relaunch:\n\n${INSTALL_COMMANDS}`,
    );
    process.exitCode = 1;
    return undefined;
  }

  // Version check: the plugin manifest is lockstep-versioned with this CLI, so
  // comparing semver cores is meaningful. Stale is loud (skills drift from the
  // tools they describe); newer is a note (update aiui itself).
  const { entry } = status;
  const marketplace = entry.id?.split("@")[1];
  const updateCommands = `  claude plugin marketplace update ${marketplace}\n  claude plugin update ${entry.id}`;
  const relation = versionRelation(entry.version, VERSION);
  if (relation === "unknown") {
    printWarning(
      `couldn't compare aiui plugin and CLI versions (plugin ${entry.version ?? "unknown"}, aiui ${VERSION})`,
      `If skills look stale:\n\n${updateCommands}`,
    );
  } else if (relation === "stale") {
    printWarning(
      `the installed aiui plugin is OUT OF DATE — plugin ${entry.version}, aiui ${VERSION}`,
      `Its skills describe an older aiui than the one launching. Update it (then relaunch):\n\n${updateCommands}`,
    );
  } else if (relation === "newer") {
    printNote(
      `the installed aiui plugin (${entry.version}) is newer than this aiui (${VERSION})`,
      "Usually harmless; if things look off, update the aiui CLI itself.",
    );
  }
  return [];
}
