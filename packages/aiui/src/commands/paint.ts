/**
 * `aiui paint url` — where should the iPad point its browser?
 *
 * The paint sidecar's LAN listener gets its port at channel startup (the
 * preferred 8788, or an OS-assigned fallback when a second session holds it),
 * so the URL isn't knowable in advance. This command finds every running
 * channel via the on-disk registry, asks each one's loopback `/paint/info`
 * route, and prints the LAN URL(s) to open on the iPad — made for
 * "run it, copy the URL, paste it on the iPad" (macOS Universal Clipboard).
 *
 * A channel without the paint sidecar simply doesn't answer `/paint/info`;
 * when none do, the command says how to enable it.
 */
import { listMcpServers } from "@habemus-papadum/aiui-claude-channel";
import chalk from "chalk";

/** One channel's paint info, as printed. */
interface PaintTarget {
  cwd: string;
  pid: number;
  port: number;
  urls: string[];
  hosts: number;
  clients: number;
}

/** Ask one channel for its paint info; undefined when it has no paint sidecar
 * (or is not actually listening any more — registry entries can be stale). */
async function queryChannel(
  port: number,
): Promise<
  { lan?: { port: number; urls: string[] }; hosts?: number; clients?: number } | undefined
> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/paint/info`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return undefined;
    }
    return (await res.json()) as { lan?: { port: number; urls: string[] } };
  } catch {
    return undefined;
  }
}

export async function runPaintUrl(opts: { json?: boolean } = {}): Promise<void> {
  const servers = listMcpServers();
  const targets: PaintTarget[] = [];
  for (const server of servers) {
    const info = await queryChannel(server.port);
    if (info?.lan) {
      targets.push({
        cwd: server.cwd,
        pid: server.pid,
        port: server.port,
        urls: info.lan.urls,
        hosts: info.hosts ?? 0,
        clients: info.clients ?? 0,
      });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ targets }, null, 2));
    return;
  }

  if (targets.length === 0) {
    console.log("No running channel is hosting the paint sidecar.");
    console.log("");
    console.log("Start one with:");
    console.log(`  ${chalk.cyan("aiui claude --aiui-sidecar paint")}`);
    console.log("");
    console.log(
      "(The paint surface binds your LAN unauthenticated, so it is opt-in — see the docs.)",
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
    console.log(
      chalk.dim(
        `  ${target.hosts} browser host(s), ${target.clients} viewer(s) — open the URL on the iPad (same Wi-Fi)`,
      ),
    );
  }
  console.log("");
}
