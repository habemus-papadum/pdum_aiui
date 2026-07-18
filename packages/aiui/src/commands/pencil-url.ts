/**
 * `aiui pencil url` — where should the iPad point its browser?
 *
 * The pencil surface rides each channel's one web server, so the URL is just
 * `http://<address>:<channelPort>/pencil/` — the open questions are WHICH
 * channel and, since a host-bound channel listens on every interface, which
 * ADDRESS. So the default is interactive (owner, 2026-07-17): pick a running
 * channel (the shared selector; auto-picks a lone one), then pick the host
 * interface — the choices follow the channel's actual bind (loopback →
 * `127.0.0.1` only; host → every non-internal IPv4 the machine holds). The
 * chosen URL is printed AND copied to the clipboard, with a nudge to carry it
 * to the iPad over macOS Universal Clipboard. A loopback-only channel still
 * prints its URL, with the reminder that reaching it needs a tunnel of the
 * user's own making (Tailscale, `ssh -L`).
 *
 * `--json` keeps the non-interactive dump for scripts: every hosting channel's
 * URLs at once. A channel without the pencil sidecar simply doesn't answer
 * `/pencil/info`. Channels are named the way the shared selector names them —
 * the registry entry's own display name, else the owning Claude session's
 * (matched by `ppid`), else the cwd.
 */
import { networkInterfaces } from "node:os";
import {
  agentsByPid,
  type ClaudeAgent,
  listClaudeAgents,
  listMcpServers,
  type RunningServer,
  selectMcpServer,
} from "@habemus-papadum/aiui-claude-channel";
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { execa } from "execa";

/** One channel's pencil surface, as printed. */
interface SurfaceTarget {
  cwd: string;
  pid: number;
  port: number;
  /** Display name: the registry entry's own, else the owning Claude session's. */
  session?: string;
  /** Whether the channel is bound beyond loopback (LAN-reachable). */
  lan: boolean;
  urls: string[];
  hosts: number;
  clients: number;
}

/** Non-internal IPv4 addresses — the URLs an iPad on the LAN can open. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

/** Fetch a channel route's JSON; undefined on any failure (stale registry
 * entries, a channel predating the route). */
async function getJson<T>(port: number, path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return undefined;
    }
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Ask one channel about its surface; undefined when it has no such sidecar
 * (or is not actually listening any more). */
async function queryChannel(
  port: number,
  prefix: string,
): Promise<{ lan: boolean; urls: string[]; hosts: number; clients: number } | undefined> {
  const info = await getJson<{ ok?: boolean; hosts?: number; clients?: number }>(
    port,
    `${prefix}/info`,
  );
  if (!info?.ok) {
    return undefined;
  }
  // The bind rides on /health; a channel too old to report it is loopback-only.
  const health = await getJson<{ host?: string }>(port, "/health");
  const lan = health?.host !== undefined && health.host !== "127.0.0.1";
  return {
    lan,
    urls: lan
      ? lanAddresses().map((ip) => `http://${ip}:${port}${prefix}/`)
      : [`http://127.0.0.1:${port}${prefix}/`],
    hosts: info.hosts ?? 0,
    clients: info.clients ?? 0,
  };
}

/** A network interface the channel's bind makes reachable, as offered in the picker. */
interface HostInterface {
  /** The OS interface name (`en0`, `lo0`) or a synthetic label (`loopback`). */
  name: string;
  address: string;
}

/**
 * The interfaces the channel is actually reachable on, given its bind:
 *  - loopback (`127.0.0.1`) → only the loopback address; an iPad can't reach it
 *    without a tunnel, but we still offer it (the user may have one).
 *  - host (`0.0.0.0`) → every non-internal IPv4 the machine holds, named by its
 *    OS interface, plus loopback last for on-machine testing.
 */
export function boundInterfaces(bindHost: string | undefined): HostInterface[] {
  const loopback: HostInterface = { name: "loopback", address: "127.0.0.1" };
  if (bindHost === undefined || bindHost === "127.0.0.1") {
    return [loopback];
  }
  const lan: HostInterface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        lan.push({ name, address: addr.address });
      }
    }
  }
  return [...lan, loopback];
}

/** Put `text` on the macOS clipboard (Universal Clipboard carries it to the
 * iPad). Returns whether it landed — non-macOS has no `pbcopy`, and we degrade
 * to just printing the URL. */
async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    await execa("pbcopy", { input: text });
    return true;
  } catch {
    return false;
  }
}

/** The display name a running channel goes by (its own, else the owning Claude
 * session's, matched by ppid). */
function channelLabel(server: RunningServer, agents: Map<number, ClaudeAgent>): string {
  return server.name ?? agents.get(server.ppid)?.name ?? server.cwd;
}

export function runPencilUrl(opts: { json?: boolean } = {}): Promise<void> {
  return opts.json ? dumpSurfaceTargets("/pencil") : pickSurfaceUrl("/pencil", "pencil");
}

/**
 * The interactive path (the default): pick a channel, then the host interface
 * the iPad should use — the choices follow the channel's actual bind — then
 * print the URL, copy it to the clipboard, and say how to get it across.
 */
async function pickSurfaceUrl(prefix: string, name: string): Promise<void> {
  const servers = listMcpServers();
  if (servers.length === 0) {
    noChannel(name);
    return;
  }

  const server = await selectMcpServer(servers);

  // Confirm the channel actually hosts the surface (every channel does, but a
  // stale registry entry or an old build might not) and read its bind.
  const info = await getJson<{ ok?: boolean }>(server.port, `${prefix}/info`);
  if (!info?.ok) {
    console.log(
      `${chalk.bold(channelLabel(server, agentsByPid(listClaudeAgents())))} is not hosting the ${name} surface.`,
    );
    process.exitCode = 1;
    return;
  }
  const health = await getJson<{ host?: string }>(server.port, "/health");
  const interfaces = boundInterfaces(health?.host);
  const lan = health?.host !== undefined && health.host !== "127.0.0.1";

  const chosen =
    interfaces.length === 1
      ? interfaces[0]
      : await select<HostInterface>({
          message: "Which host interface should the iPad reach the channel on?",
          choices: interfaces.map((iface) => ({
            name: `${iface.address}  ${chalk.dim(`(${iface.name})`)}`,
            value: iface,
          })),
        });

  const url = `http://${chosen.address}:${server.port}${prefix}/`;
  const copied = await copyToClipboard(url);

  console.log("");
  console.log(`  ${chalk.cyan(url)}`);
  console.log("");
  if (copied) {
    console.log(chalk.dim("  Copied to your clipboard."));
    console.log(
      chalk.dim("  Use Universal Clipboard (⌘V on the iPad) to paste it into Safari there."),
    );
  } else {
    console.log(chalk.dim("  (Copy it to the iPad however you like.)"));
  }
  if (!lan) {
    console.log(
      chalk.dim(
        "  This channel is loopback-only: the iPad needs a tunnel to this port " +
          "(Tailscale, ssh -L), or relaunch with --aiui-bind host.",
      ),
    );
  }
  console.log("");
}

/** The empty-registry message, shared by both paths. */
function noChannel(name: string): void {
  console.log(`No running channel is hosting the ${name} surface.`);
  console.log("");
  console.log(`Every channel hosts it — start a session with ${chalk.cyan("aiui claude")} (or a`);
  console.log(
    `standalone ${chalk.cyan("aiui mcp serve")}), then run this again to reach the ${name} surface.`,
  );
  process.exitCode = 1;
}

/** `--json`: every hosting channel's URLs at once, for scripts (no prompts). */
async function dumpSurfaceTargets(prefix: string): Promise<void> {
  const servers = listMcpServers();
  const agents =
    servers.length > 0 ? agentsByPid(listClaudeAgents()) : new Map<number, ClaudeAgent>();
  const targets: SurfaceTarget[] = [];
  for (const server of servers) {
    const surface = await queryChannel(server.port, prefix);
    if (surface) {
      const session = server.name ?? agents.get(server.ppid)?.name;
      targets.push({
        cwd: server.cwd,
        pid: server.pid,
        port: server.port,
        ...(session !== undefined ? { session } : {}),
        ...surface,
      });
    }
  }
  console.log(JSON.stringify({ targets }, null, 2));
}
