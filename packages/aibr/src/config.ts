import { isAbsolute, resolve } from "node:path";
import {
  type Config,
  fields,
  name,
  object,
  type Paths,
  parseTarget,
  type Selection,
  string,
  strings,
  type Target,
} from "./model.ts";
import { findProject } from "./project.ts";
import { locked, readJson, writeJson } from "./storage.ts";

export const defaultConfig = (): Config => ({
  schemaVersion: 1,
  defaultTarget: "default",
  serverName: "chrome-devtools",
  targets: {},
  providers: {},
  agents: { claude: { args: [], yolo: false }, codex: { args: [], yolo: false } },
});

export function parseConfig(raw: unknown): Config {
  const v = object(raw, "Config");
  fields(
    v,
    ["schemaVersion", "defaultTarget", "serverName", "targets", "providers", "agents"],
    "config",
  );
  if (v.schemaVersion !== 1) throw new Error("Unsupported config schemaVersion");
  const config = defaultConfig();
  if (v.defaultTarget !== undefined) config.defaultTarget = name(v.defaultTarget);
  if (v.serverName !== undefined) config.serverName = name(v.serverName);
  const agents = object(v.agents ?? {}, "Agents");
  fields(agents, ["claude", "codex"], "agents");
  for (const agent of ["claude", "codex"] as const) {
    if (agents[agent] === undefined) continue;
    const defaults = object(agents[agent], `${agent} defaults`);
    fields(defaults, ["args", "yolo"], `${agent} defaults`);
    if (defaults.yolo !== undefined && typeof defaults.yolo !== "boolean")
      throw new Error(`${agent}.yolo must be boolean`);
    config.agents[agent] = {
      args: strings(defaults.args ?? [], `${agent}.args`),
      yolo: defaults.yolo === true,
    };
    if (config.agents[agent].args.includes("--"))
      throw new Error("Saved default arguments cannot contain an argument terminator (--)");
  }
  for (const [key, value] of Object.entries(object(v.targets ?? {}, "Targets"))) {
    const target = parseTarget(value);
    if ("dataDir" in target && !isAbsolute(target.dataDir))
      throw new Error("Saved dataDir must be absolute");
    config.targets[name(key)] = target;
  }
  for (const [key, value] of Object.entries(object(v.providers ?? {}, "Providers"))) {
    const provider = object(value, "Provider");
    fields(provider, ["command", "args", "cwd", "timeoutMs"], "provider");
    const timeoutMs = provider.timeoutMs ?? 15_000;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    ) {
      throw new Error("Provider timeoutMs must be 1..300000");
    }
    const cwd = provider.cwd === undefined ? undefined : string(provider.cwd, "Provider cwd");
    if (cwd && !isAbsolute(cwd)) throw new Error("Provider cwd must be absolute");
    config.providers[name(key)] = {
      command: string(provider.command, "Provider command"),
      args: strings(provider.args ?? [], "Provider args"),
      cwd,
      timeoutMs,
    };
  }
  return config;
}

export async function loadConfig(p: Paths): Promise<Config> {
  const raw = await readJson(p.config);
  return raw === undefined ? defaultConfig() : parseConfig(raw);
}

export async function updateConfig(p: Paths, edit: (config: Config) => void): Promise<void> {
  await locked(p.config, async () => {
    const config = await loadConfig(p);
    edit(config);
    await writeJson(p.config, parseConfig(config));
  });
}

export function namedTarget(config: Config, key: string, seen = new Set<string>()): Target {
  name(key);
  if (seen.has(key)) throw new Error(`Circular profile reference: ${[...seen, key].join(" → ")}`);
  seen.add(key);
  const target = Object.hasOwn(config.targets, key) ? config.targets[key] : { profile: key };
  if (!("profile" in target) || target.profile === key) return target;
  const resolved = namedTarget(config, target.profile, seen);
  if (target.autoConnect) {
    if (!("profile" in resolved || "dataDir" in resolved))
      throw new Error("--auto-connect requires a local profile");
    return { ...resolved, autoConnect: true };
  }
  return resolved;
}

export interface SelectOptions {
  profile?: string;
  userDataDir?: string;
  target?: string;
  endpoint?: string;
  connectPort?: number;
  autoConnect?: boolean;
}

/** Nearest file wins; an explicit selector bypasses ancestor files completely. */
export async function selectTarget(
  config: Config,
  options: SelectOptions,
  cwd = process.cwd(),
): Promise<Selection> {
  const selectors = [
    options.profile,
    options.userDataDir,
    options.target,
    options.endpoint,
    options.connectPort,
  ];
  if (selectors.filter((v) => v !== undefined).length > 1)
    throw new Error(
      "Choose only one of --profile, --user-data-dir, --target, --endpoint or --connect-port",
    );
  if (options.autoConnect && !options.userDataDir && !options.profile)
    throw new Error("--auto-connect requires --profile or --user-data-dir");
  if (options.profile) {
    const target = namedTarget(config, options.profile);
    if (options.autoConnect && !("profile" in target || "dataDir" in target))
      throw new Error("--auto-connect requires a local profile");
    return {
      label: options.profile,
      source: "--profile",
      target: options.autoConnect ? { ...target, autoConnect: true } : target,
    };
  }
  if (options.userDataDir)
    return {
      label: options.userDataDir,
      source: "--user-data-dir",
      target: { dataDir: resolve(cwd, options.userDataDir), autoConnect: options.autoConnect },
    };
  if (options.endpoint || options.connectPort !== undefined) {
    const target = parseTarget({
      endpoint: options.endpoint ?? `http://127.0.0.1:${options.connectPort}`,
    });
    return {
      label: "explicit endpoint",
      source: options.endpoint ? "--endpoint" : "--connect-port",
      target,
    };
  }
  if (options.target)
    return {
      label: options.target,
      source: "--target",
      target: namedTarget(config, options.target),
    };
  const project = await findProject(cwd);
  if (project)
    return {
      label: project.target,
      target: namedTarget(config, project.target),
      source: project.file,
    };
  return {
    label: config.defaultTarget,
    target: namedTarget(config, config.defaultTarget),
    source: "user default",
  };
}
