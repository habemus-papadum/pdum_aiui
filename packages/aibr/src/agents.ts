import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { type Agent, type Config, type Connection, DEVELOPMENT_MEDIA_ARGS } from "./model.ts";

export const YOLO_FLAGS: Record<Agent, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
};

export interface McpEntry {
  command: string;
  args: string[];
}
export interface LaunchPlan {
  executable: string;
  args: string[];
  cwd: string;
}

export function agentName(value: string): Agent {
  if (value !== "claude" && value !== "codex") throw new Error("Agent must be claude or codex");
  return value;
}

export async function findExecutable(command: string, env = process.env): Promise<string> {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [resolve(command)]
      : (env.PATH ?? "").split(delimiter).map((dir) => resolve(dir || ".", command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Executable ${command} was not found on PATH`);
}

export function requireExecve(): void {
  if (!["darwin", "linux"].includes(process.platform) || typeof process.execve !== "function") {
    throw new Error("aibr requires Node 24.5+ on macOS or Linux, with process.execve available");
  }
}

async function mcpCommand(args: string[]): Promise<McpEntry> {
  const req = createRequire(import.meta.url);
  const manifestPath = req.resolve("chrome-devtools-mcp/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const script = resolve(dirname(manifestPath), manifest.bin["chrome-devtools-mcp"]);
  await access(script, constants.R_OK);
  return {
    command: process.execPath,
    args: [script, ...args, "--no-usage-statistics"],
  };
}

export async function mcpEntry(connection: Connection): Promise<McpEntry> {
  return mcpCommand(
    connection.autoConnectDir
      ? ["--auto-connect", "--user-data-dir", connection.autoConnectDir]
      : ["--ws-endpoint", connection.wsEndpoint],
  );
}

/** MCP owns the isolated directory and browser. No CDP port or persistent profile is supplied. */
export async function temporaryMcpEntry(executable: string, headless: boolean): Promise<McpEntry> {
  return mcpCommand([
    "--isolated",
    "--executable-path",
    executable,
    `--headless=${headless}`,
    ...DEVELOPMENT_MEDIA_ARGS.map((arg) => `--chrome-arg=${arg}`),
  ]);
}

function toml(value: string | string[] | boolean | number | Record<string, unknown>): string {
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  if (typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v as Parameters<typeof toml>[0])}`)
      .join(", ")} }`;
  return JSON.stringify(value);
}

/** Protect the one MCP entry owned by aibr from passthrough/default argument collisions. */
export function validateAgentArgs(agent: Agent, args: string[], serverName: string): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (agent === "claude" && /^(--mcp-config|--strict-mcp-config)(=|$)/.test(arg)) {
      throw new Error(
        "aibr owns --mcp-config; use --exclusive-mcp for an exclusive Claude MCP configuration",
      );
    }
    if (agent === "codex") {
      let override: string | undefined;
      if (arg === "-c" || arg === "--config") override = args[++i];
      else if (arg.startsWith("--config=")) override = arg.slice(9);
      else if (arg.startsWith("-c") && arg.length > 2) override = arg.slice(2);
      if (override) {
        const key = override.split("=", 1)[0].trim().replace(/["']/g, "");
        if (
          key === "mcp_servers" ||
          key === `mcp_servers.${serverName}` ||
          key.startsWith(`mcp_servers.${serverName}.`)
        ) {
          throw new Error(`aibr owns the mcp_servers.${serverName} override`);
        }
      }
      if (arg === "--remote" || arg.startsWith("--remote="))
        throw new Error(
          "aibr configures the local Codex process; --remote app-server launches are not supported",
        );
    }
  }
}

export function defaultAgentArgs(
  config: Config,
  agent: Agent,
  options: { defaultArgs?: boolean; yolo?: boolean } = {},
): string[] {
  const defaults = config.agents[agent];
  const args = options.defaultArgs === false ? [] : [...defaults.args];
  const yolo = options.yolo ?? (options.defaultArgs === false ? false : defaults.yolo);
  // --no-yolo also removes an explicitly saved copy of the same flag.
  const filtered = options.yolo === false ? args.filter((arg) => arg !== YOLO_FLAGS[agent]) : args;
  if (yolo && !filtered.includes(YOLO_FLAGS[agent])) filtered.push(YOLO_FLAGS[agent]);
  return filtered;
}

export function buildAgentPlan(
  agent: Agent,
  executable: string,
  entry: McpEntry,
  config: Config,
  passthrough: string[],
  options: {
    defaultArgs?: boolean;
    yolo?: boolean;
    exclusiveMcp?: boolean;
    cwd?: string;
  } = {},
): LaunchPlan {
  const defaults = defaultAgentArgs(config, agent, options);
  if (defaults.includes("--"))
    throw new Error("Saved default arguments cannot contain an argument terminator (--)");
  validateAgentArgs(agent, defaults, config.serverName);
  validateAgentArgs(agent, passthrough, config.serverName);
  const mcpArgs =
    agent === "claude"
      ? [
          ...(options.exclusiveMcp ? ["--strict-mcp-config"] : []),
          "--mcp-config",
          JSON.stringify({ mcpServers: { [config.serverName]: { type: "stdio", ...entry } } }),
        ]
      : [
          "-c",
          `mcp_servers.${config.serverName}=${toml({ ...entry, enabled: true, required: true, startup_timeout_sec: 30 })}`,
        ];
  // Claude's --mcp-config is variadic. Put it LAST (before an explicit --)
  // so a positional prompt cannot be swallowed as another configuration file.
  const separator = passthrough.indexOf("--");
  const args =
    agent === "claude"
      ? [
          ...defaults,
          ...(separator < 0 ? passthrough : passthrough.slice(0, separator)),
          ...mcpArgs,
          ...(separator < 0 ? [] : passthrough.slice(separator)),
        ]
      : [...defaults, ...mcpArgs, ...passthrough];
  return { executable, args, cwd: options.cwd ?? process.cwd() };
}

export async function execPlan(plan: LaunchPlan): Promise<void> {
  requireExecve();
  // All profile locks, file descriptors and UI resources have already been released.
  await Promise.all([
    new Promise<void>((r) => process.stdout.write("", () => r())),
    new Promise<void>((r) => process.stderr.write("", () => r())),
  ]);
  process.chdir(plan.cwd);
  const exec = process.execve;
  if (!exec) throw new Error("process.execve is unavailable");
  exec(
    plan.executable,
    [plan.executable, ...plan.args],
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );
}
