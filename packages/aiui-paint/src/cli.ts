/**
 * The `aiui-paint` bin: start the LAN paint-stream relay.
 *
 * The `#!/usr/bin/env node` shebang is prepended to the built `dist/cli.js` by a
 * rollup banner (vite.config.ts), so this source stays valid TypeScript. In the
 * workspace, run it through tsx (e.g. `pnpm paint`).
 */
import { networkInterfaces } from "node:os";
import { Command } from "commander";
import { DEFAULT_RELAY_PORT, startPaintRelay } from "./relay";

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

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("aiui-paint")
    .description("Start the aiui paint-stream relay (LAN — view/draw a browser from an iPad).")
    .option("-p, --port <port>", "port to bind", String(DEFAULT_RELAY_PORT))
    .option("-H, --host <addr>", "bind address", "0.0.0.0")
    .action(async (opts: { port: string; host: string }) => {
      const relay = await startPaintRelay({ host: opts.host, port: Number(opts.port) });
      const port = relay.port;
      process.stdout.write("\naiui paint relay listening.\n\n");
      process.stdout.write("  Open the iPad client at one of:\n");
      const addrs = lanAddresses();
      if (addrs.length === 0) {
        process.stdout.write(`    http://localhost:${port}/\n`);
      }
      for (const addr of addrs) {
        process.stdout.write(`    http://${addr}:${port}/\n`);
      }
      process.stdout.write(
        "\n  ⚠️  This binds the LAN and is UNAUTHENTICATED — use only on a trusted network.\n" +
          "     It is separate from the loopback channel server, whose posture is unchanged.\n\n" +
          "  Press Ctrl-C to stop.\n",
      );

      const shutdown = (): void => {
        void relay.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  await program.parseAsync(process.argv);
}

void main();
