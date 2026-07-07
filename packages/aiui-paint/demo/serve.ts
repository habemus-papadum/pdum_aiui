/**
 * One command to run the standalone demo: start the paint relay AND a Vite dev
 * server for the demo app, wired together.
 *
 *     pnpm paint:demo
 *
 * The relay port is injected into the demo via Vite `define` so the page's host
 * controller dials the right backend. The demo opens automatically on this
 * machine; the terminal prints the LAN URL to open on an iPad.
 */
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { DEFAULT_RELAY_PORT, startPaintRelay } from "../src/relay";

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, "../../..");

/** Non-internal IPv4 addresses — the URLs an iPad on the LAN can open. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const relay = await startPaintRelay({ port: DEFAULT_RELAY_PORT });

  const vite = await createServer({
    root: demoDir,
    configFile: false, // ignore the package's lib-build vite.config.ts
    define: { __RELAY_PORT__: JSON.stringify(relay.port) },
    server: {
      host: true,
      // A distinctive port so it doesn't collide with Vite's / VitePress's 5173.
      port: 5190,
      // Auto-open the demo on this machine (set PAINT_DEMO_NO_OPEN=1 to suppress).
      open: !process.env.PAINT_DEMO_NO_OPEN,
      // Serve the linked workspace sources (aiui-paint / aiui-ink) the demo imports.
      fs: { allow: [repoRoot] },
    },
  });
  await vite.listen();

  vite.printUrls();
  process.stdout.write("\n  iPad — open the paint client at one of:\n");
  const addrs = lanAddresses();
  if (addrs.length === 0) {
    process.stdout.write(`    http://localhost:${relay.port}/\n`);
  }
  for (const ip of addrs) {
    process.stdout.write(`    http://${ip}:${relay.port}/\n`);
  }
  process.stdout.write(
    "\n  Draw on the desktop with your mouse; pick “aiui paint demo” on the iPad to draw remotely.\n" +
      "  ⚠️  The relay binds the LAN and is UNAUTHENTICATED — trusted network only.\n" +
      "  Ctrl-C to stop.\n",
  );

  const shutdown = (): void => {
    void Promise.allSettled([vite.close(), relay.close()]).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
