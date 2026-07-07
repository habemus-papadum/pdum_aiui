/**
 * `aiui paint url` — where should the iPad point its browser?
 *
 * The paint surface rides each channel's one web server, so the URL is just
 * `http://<address>:<channelPort>/paint/` — the open question is which
 * addresses can reach it. This command finds every running channel via the
 * on-disk registry, confirms the paint sidecar answers `/paint/info`, and reads
 * the channel's bind from `/health`: a host-bound channel gets its LAN URL(s)
 * printed (open one on the iPad — macOS Universal Clipboard pastes straight
 * across); a loopback-bound channel gets the loopback URL plus a reminder that
 * reaching it from the iPad is a tunnel of the user's own making (Tailscale,
 * `ssh -L` — see docs/guide/paint-stream).
 *
 * A channel without the paint sidecar simply doesn't answer `/paint/info`.
 */
import { networkInterfaces } from "node:os";
import { listMcpServers } from "@habemus-papadum/aiui-claude-channel";
import chalk from "chalk";

/** One channel's paint surface, as printed. */
interface PaintTarget {
  cwd: string;
  pid: number;
  port: number;
  /** Whether the channel is bound beyond loopback (LAN-reachable). */
  lan: boolean;
  urls: string[];
  hosts: number;
  clients: number;
}

/** Non-internal IPv4 addresses — the URLs an iPad on the LAN can open. (The
 * demo server keeps its own copy; the sidecar itself no longer needs one.) */
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

/** Ask one channel about its paint surface; undefined when it has no paint
 * sidecar (or is not actually listening any more). */
async function queryChannel(
  port: number,
): Promise<{ lan: boolean; urls: string[]; hosts: number; clients: number } | undefined> {
  const info = await getJson<{ ok?: boolean; hosts?: number; clients?: number }>(
    port,
    "/paint/info",
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
      ? lanAddresses().map((ip) => `http://${ip}:${port}/paint/`)
      : [`http://127.0.0.1:${port}/paint/`],
    hosts: info.hosts ?? 0,
    clients: info.clients ?? 0,
  };
}

export async function runPaintUrl(opts: { json?: boolean } = {}): Promise<void> {
  const servers = listMcpServers();
  const targets: PaintTarget[] = [];
  for (const server of servers) {
    const paint = await queryChannel(server.port);
    if (paint) {
      targets.push({ cwd: server.cwd, pid: server.pid, port: server.port, ...paint });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ targets }, null, 2));
    return;
  }

  if (targets.length === 0) {
    console.log("No running channel is hosting the paint surface.");
    console.log("");
    console.log(
      `It is on by default — start a session with ${chalk.cyan("aiui claude")}. If it's off here,`,
    );
    console.log(
      `check for ${chalk.cyan("sidecars.paint false")} in config or a --aiui-no-sidecar flag.`,
    );
    process.exitCode = 1;
    return;
  }

  for (const target of targets) {
    console.log("");
    console.log(`${chalk.bold(target.cwd)} ${chalk.dim(`(channel :${target.port})`)}`);
    for (const url of target.urls.length ? target.urls : ["(no LAN address found)"]) {
      console.log(`  ${chalk.cyan(url)}`);
    }
    const reach = target.lan
      ? "open the URL on the iPad (same Wi-Fi)"
      : "loopback-only — the iPad needs a tunnel to this port (Tailscale, ssh -L), " +
        "or relaunch with --aiui-bind host";
    console.log(
      chalk.dim(`  ${target.hosts} browser host(s), ${target.clients} viewer(s) — ${reach}`),
    );
  }
  console.log("");
}
