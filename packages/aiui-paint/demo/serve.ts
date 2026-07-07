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
  // Ports are overridable so a second copy (or a test) doesn't clash with a
  // relay already on the defaults.
  const relayPort = Number(process.env.PAINT_DEMO_RELAY_PORT) || DEFAULT_RELAY_PORT;
  const demoPort = Number(process.env.PAINT_DEMO_PORT) || 5190;
  const relay = await startPaintRelay({ port: relayPort });

  const vite = await createServer({
    root: demoDir,
    configFile: false, // ignore the package's lib-build vite.config.ts
    define: { __RELAY_PORT__: JSON.stringify(relay.port) },
    server: {
      host: true,
      // A distinctive port so it doesn't collide with Vite's / VitePress's 5173.
      port: demoPort,
      // Off by default: auto-open uses macOS Apple Events, which pops a "control
      // Chrome" permission prompt. Print the URLs instead; set PAINT_DEMO_OPEN=1
      // to opt back in.
      open: process.env.PAINT_DEMO_OPEN ? "/" : false,
      // Serve the linked workspace sources (aiui-paint / aiui-ink) the demo imports.
      fs: { allow: [repoRoot] },
    },
  });
  await vite.listen();

  const addrs = lanAddresses();
  const lan = addrs[0] ?? "localhost";
  process.stdout.write("\n  aiui paint — standalone demo\n");
  process.stdout.write("  ─────────────────────────────\n");
  process.stdout.write("  1) On THIS computer, open the demo:\n");
  process.stdout.write(`       http://localhost:${demoPort}/\n`);
  process.stdout.write("  2) On your iPad (same Wi-Fi), open the paint client:\n");
  for (const ip of addrs.length ? addrs : ["localhost"]) {
    process.stdout.write(`       http://${ip}:${relay.port}/\n`);
  }
  process.stdout.write(
    `\n  Then pick “aiui paint demo” on the iPad. Draw on either side; the ink is shared.\n` +
      `  Switch JPEG⇄WebRTC with the toolbar button, or start at ` +
      `http://localhost:${demoPort}/?video=webrtc\n` +
      `  ⚠️  The relay binds the LAN (${lan}:${relay.port}) and is UNAUTHENTICATED — trusted network only.\n` +
      "  Ctrl-C to stop.\n",
  );

  const shutdown = (): void => {
    void Promise.allSettled([vite.close(), relay.close()]).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
