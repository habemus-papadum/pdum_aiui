import { access } from "node:fs/promises";
import { findExecutable, mcpEntry, requireExecve } from "./agents.ts";
import { loadConfig, namedTarget, selectTarget, updateConfig } from "./config.ts";
import { browserExecutable, installations } from "./installations.ts";
import { formatInstallations, formatProfiles, profileInventory } from "./inventory.ts";
import {
  type BrowserFamily,
  type Config,
  type Paths,
  redactEndpoint,
  type Selection,
  type Target,
} from "./model.ts";
import { namedProfileDir, readProfile } from "./profiles.ts";
import { chooseBrowser, installWithFeedback, setupProfile } from "./setup.ts";
import { pickProfile, terminal } from "./ui.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function check<T>(action: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await action() };
  } catch (error) {
    return { error: message(error) };
  }
}

async function selectionHealth(p: Paths, config: Config, selected: Selection) {
  const target = selected.target;
  if ("endpoint" in target)
    return {
      ...selected,
      target: { endpoint: redactEndpoint(target.endpoint) },
      state: "remote",
      note: "Endpoint saved; reachability is not probed by doctor",
    };
  if ("provider" in target) {
    if (!Object.hasOwn(config.providers, target.provider))
      return { ...selected, state: "invalid", error: `Unknown provider ${target.provider}` };
    return {
      ...selected,
      state: "provider",
      note: "Provider configured; doctor does not run providers or open tunnels",
    };
  }
  const dir = "profile" in target ? namedProfileDir(p, target.profile, config) : target.dataDir;
  const profile = await check(() => readProfile(dir));
  if ("error" in profile)
    return {
      ...selected,
      state: profile.error.startsWith("No aibr profile") ? "missing profile" : "invalid profile",
      dir,
      error: profile.error,
    };
  const executable = await check(() => browserExecutable(p, profile.value.browser));
  return {
    ...selected,
    state: "error" in executable ? "missing browser" : "ready",
    dir,
    ...executable,
  };
}

export async function diagnose(p: Paths, cwd = process.cwd()) {
  const config = await check(() => loadConfig(p));
  const savedConfig = await check(() => access(p.config).then(() => p.config));
  const node = await check(async () => {
    requireExecve();
    return `${process.version} (${process.platform}/${process.arch})`;
  });
  const agents = {
    claude: await check(() => findExecutable("claude")),
    codex: await check(() => findExecutable("codex")),
  };
  const mcp = await check(() =>
    mcpEntry({
      endpoint: "http://127.0.0.1:9222",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/diagnostic",
      browserVersion: "diagnostic",
    }),
  );
  const installed = await check(() => installations(p));
  if ("error" in config)
    return { paths: p, node, agents, mcp, config, savedConfig, installations: installed };
  const value = config.value;
  const profiles = await check(() => profileInventory(p, value));
  const defaultCheck = await check(async () =>
    selectionHealth(p, value, {
      label: value.defaultTarget,
      source: "user default",
      target: namedTarget(value, value.defaultTarget),
    }),
  );
  const globalDefault =
    "error" in defaultCheck
      ? {
          label: value.defaultTarget,
          source: "user default",
          state: "invalid",
          error: defaultCheck.error,
        }
      : defaultCheck.value;
  const current = await check(async () =>
    selectionHealth(p, value, await selectTarget(value, {}, cwd)),
  );
  const targets: Record<string, Target> = Object.fromEntries(
    Object.entries(value.targets).map(([key, target]) => [
      key,
      "endpoint" in target ? { endpoint: redactEndpoint(target.endpoint) } : target,
    ]),
  );
  const providers = await Promise.all(
    Object.entries(value.providers).map(async ([name, provider]) => ({
      name,
      ...provider,
      executable: await check(() => findExecutable(provider.command)),
    })),
  );
  return {
    paths: p,
    node,
    agents,
    mcp,
    config: { value: { ...value, targets } },
    savedConfig,
    installations: installed,
    profiles,
    globalDefault,
    current,
    providers,
  };
}

export function formatDiagnosis(report: Awaited<ReturnType<typeof diagnose>>): string {
  const lines = ["aibr system check"];
  const show = (label: string, result: { value: unknown } | { error: string }) =>
    lines.push(
      `${label}: ${"error" in result ? `MISSING / ERROR — ${result.error}` : typeof result.value === "string" ? result.value : "ready"}`,
    );
  show("Node / execve", report.node);
  show("Claude Code", report.agents.claude);
  show("Codex", report.agents.codex);
  show("Chrome DevTools MCP", report.mcp);
  lines.push(
    `Config: ${report.paths.config}${"error" in report.savedConfig ? " (not saved; built-in defaults apply)" : ""}`,
    `Data: ${report.paths.data}`,
    `Cache: ${report.paths.cache}`,
    `Runtime / logs: ${report.paths.state}`,
  );
  lines.push(
    "\nInstalled browsers (aibr cache):",
    "error" in report.installations
      ? report.installations.error
      : formatInstallations(report.installations.value),
  );
  if ("error" in report.config) lines.push(`\nConfig error: ${report.config.error}`);
  else {
    const config = report.config.value;
    lines.push(`\nMCP server name: ${config.serverName}`);
    for (const agent of ["claude", "codex"] as const)
      lines.push(
        `${agent} defaults: ${JSON.stringify(config.agents[agent].args)} · YOLO ${config.agents[agent].yolo ? "on" : "off"}`,
      );
    lines.push(
      "\nProfiles:",
      !report.profiles
        ? "Unavailable"
        : "error" in report.profiles
          ? report.profiles.error
          : formatProfiles(report.profiles.value, config.defaultTarget),
    );
    if (report.globalDefault)
      lines.push(
        `\nUser default: ${report.globalDefault.label} — ${report.globalDefault.state}`,
        ...("error" in report.globalDefault ? [`  ${report.globalDefault.error}`] : []),
      );
    if (report.current) {
      if ("error" in report.current) lines.push(`Directory selection: ${report.current.error}`);
      else
        lines.push(
          `Directory selection: ${report.current.value.label} (${report.current.value.source}) — ${report.current.value.state}`,
          ...("error" in report.current.value ? [`  ${report.current.value.error}`] : []),
        );
    }
    lines.push(
      `\nSaved targets: ${Object.keys(config.targets).length ? JSON.stringify(config.targets, null, 2) : "none"}`,
    );
    lines.push(
      `Providers: ${report.providers?.length ? JSON.stringify(report.providers, null, 2) : "none"}`,
    );
  }
  lines.push(
    "\nNext steps: aibr browser install · aibr profile create · aibr config default <target> · aibr init --profile",
  );
  return lines.join("\n");
}

/** Guided repairs are explicit offers, only from an interactive doctor invocation. */
export async function offerSetup(p: Paths, ui = terminal): Promise<boolean> {
  if (!ui.interactive) return false;
  let report = await diagnose(p);
  if ("error" in report.config) return false;
  let changed = false;
  if (report.globalDefault?.state === "missing profile") {
    const rows =
      report.profiles && "value" in report.profiles
        ? report.profiles.value.filter((row) => !row.error)
        : [];
    if (rows.length && (await ui.confirm("Choose an existing profile as the user default?"))) {
      const key = await pickProfile(p, await loadConfig(p), ui);
      await updateConfig(p, (value) => {
        value.defaultTarget = key;
      });
      changed = true;
    } else if (
      await ui.confirm(`Create the missing default profile (${report.config.value.defaultTarget})?`)
    ) {
      const key = report.config.value.defaultTarget;
      // A damaged/external saved target must be repaired in place, not overwritten.
      if (Object.hasOwn(report.config.value.targets, key))
        ui.note(
          `Repair the saved target with aibr target add ${key}, or choose a different default with aibr config default <target>.`,
        );
      else {
        const result = await setupProfile(p, key, {}, false, ui);
        ui.note(`Created ${key}: ${result.dir}`);
        changed = true;
      }
    }
    report = await diagnose(p);
  }
  const missing = new Set<BrowserFamily>();
  if (report.profiles && "value" in report.profiles)
    for (const row of report.profiles.value)
      if (row.browserError && row.profile && "managed" in row.profile.browser)
        missing.add(row.profile.browser.managed);
  if (missing.size) {
    for (const browser of missing)
      if (await ui.confirm(`Install ${browser} for profiles missing their browser?`)) {
        await installWithFeedback(p, browser, undefined, ui);
        changed = true;
      }
  } else if (
    "value" in report.installations &&
    !report.installations.value.some((b) => b.available) &&
    !["remote", "provider", "ready"].includes(report.globalDefault?.state ?? "") &&
    (await ui.confirm("No managed browsers installed. Install one now?"))
  ) {
    await installWithFeedback(p, await chooseBrowser(p, ui), undefined, ui);
    changed = true;
  }
  return changed;
}
