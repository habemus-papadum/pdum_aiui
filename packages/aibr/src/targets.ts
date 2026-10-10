import { realpath } from "node:fs/promises";
import { browserStatus, ensureBrowser } from "./browser.ts";
import { autoConnection, probeEndpoint } from "./cdp.ts";
import { namedTarget } from "./config.ts";
import {
  type Config,
  type Connection,
  type Paths,
  redactEndpoint,
  type Selection,
  type Target,
} from "./model.ts";
import { listProfiles, namedProfileDir, readProfile } from "./profiles.ts";
import { discover, resolveProvider } from "./providers.ts";

export async function resolveTarget(
  p: Paths,
  config: Config,
  target: Target,
  start = true,
  overrides: { headless?: boolean } = {},
): Promise<Connection> {
  if ("profile" in target) {
    const resolved = namedTarget(config, target.profile);
    target = target.autoConnect ? { ...resolved, autoConnect: true } : resolved;
  }
  if (
    overrides.headless !== undefined &&
    ("endpoint" in target || "provider" in target || target.autoConnect)
  )
    throw new Error(
      "Headless overrides require a managed local profile; endpoint and auto-connect modes only attach",
    );
  if ("endpoint" in target) return probeEndpoint(target.endpoint);
  if ("provider" in target) {
    const provider = Object.hasOwn(config.providers, target.provider)
      ? config.providers[target.provider]
      : undefined;
    if (!provider) throw new Error(`Unknown provider ${target.provider}`);
    return probeEndpoint(await resolveProvider(provider, target.id, start));
  }
  const inputDir =
    "profile" in target ? namedProfileDir(p, target.profile, config) : target.dataDir;
  if (!target.autoConnect) await readProfile(inputDir);
  const dir = await realpath(inputDir);
  if (target.autoConnect) return autoConnection(dir);
  if (start) return ensureBrowser(p, dir, overrides);
  const status = await browserStatus(p, dir);
  if (!status.runtime) throw new Error(status.detail ?? `Browser is ${status.state}`);
  if (overrides.headless !== undefined && status.runtime.launch.headless !== overrides.headless)
    throw new Error(
      "Browser is running in a different headless mode; explicitly stop/start it to change modes",
    );
  return status.runtime.connection;
}

export interface TargetRow {
  label: string;
  source: string;
  target: Target;
  status: string;
  detail?: string;
}

export async function listTargets(
  p: Paths,
  config: Config,
  includeProviders = false,
): Promise<TargetRow[]> {
  const rows: TargetRow[] = [];
  for (const { dir, profile } of await listProfiles(p)) {
    // A saved target intentionally shadows a profile of the same name.
    if (Object.hasOwn(config.targets, profile.name)) continue;
    const status = await browserStatus(p, dir);
    rows.push({
      label: profile.name,
      source: "profile",
      target: { profile: profile.name },
      status: status.state,
      detail: `${"managed" in profile.browser ? profile.browser.managed : profile.browser.executable} · ${status.runtime ? redactEndpoint(status.runtime.connection.endpoint) : `port ${profile.launch.debugPort}`} · ${dir}${status.changedSettings ? " · restart required" : ""}`,
    });
  }
  for (const [label, target] of Object.entries(config.targets)) {
    try {
      if ("provider" in target) {
        rows.push({
          label,
          source: "saved target",
          target,
          status: "provider",
          detail: `${target.provider}: ${target.id}`,
        });
        continue;
      }
      const connection = await resolveTarget(p, config, target, false);
      rows.push({
        label,
        source: "saved target",
        target,
        status: "reachable",
        detail: redactEndpoint(connection.endpoint),
      });
    } catch (error) {
      rows.push({
        label,
        source: "saved target",
        target,
        status: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (includeProviders) {
    for (const [key, provider] of Object.entries(config.providers)) {
      for (const candidate of await discover(provider))
        rows.push({
          label: candidate.label,
          source: `provider ${key}`,
          target: { provider: key, id: candidate.id },
          status: "discovered",
          detail: [candidate.host, candidate.detail].filter(Boolean).join(" · "),
        });
    }
  }
  return rows;
}

export function selectionForRow(row: TargetRow): Selection {
  return { label: row.label, source: `picker (${row.source})`, target: row.target };
}
