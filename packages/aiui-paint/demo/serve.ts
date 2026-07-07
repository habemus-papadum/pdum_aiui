/**
 * One command to run the standalone demo: a **bespoke Express server** hosting
 * the paint backend, plus a Vite dev server for the demo app, wired together.
 *
 *     pnpm paint:demo
 *
 * This is the "no channel, no MCP, no sidecar" deployment the paint backend is
 * designed to permit — the same {@link createPaintBackend} the channel sidecar
 * mounts, here mounted on a plain Express app you own: forward requests to
 * `handleHttp`, upgrades to `handleUpgrade`, dispose on shutdown. Anything that
 * can do those three things can host the paint stream.
 *
 * The backend port is injected into the demo page via Vite `define` so its host
 * controller dials the right backend. The terminal prints the LAN URL to open
 * on an iPad.
 */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer as createViteServer } from "vite";
import { createPaintBackend } from "../src/backend";

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, "../../..");

/** The demo backend's preferred LAN port (outside the usual dev-server range). */
const DEFAULT_BACKEND_PORT = 8788;

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
  // backend already on the defaults.
  const backendPort = Number(process.env.PAINT_DEMO_RELAY_PORT) || DEFAULT_BACKEND_PORT;
  const demoPort = Number(process.env.PAINT_DEMO_PORT) || 5190;

  // ── the bespoke server: Express + the paint backend, LAN-bound ─────────────
  const backend = createPaintBackend({
    session: { project: "aiui paint demo" },
    log: (line) => process.stderr.write(`  ${line}\n`),
  });
  const app = express();
  app.use((req, res, next) => {
    if (!backend.handleHttp(req, res)) {
      next();
    }
  });
  const httpServer = createServer(app);
  httpServer.on("upgrade", (req, socket, head) => {
    if (!backend.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(backendPort, "0.0.0.0", () => resolveListen());
  });

  const vite = await createViteServer({
    root: demoDir,
    configFile: false, // ignore the package's lib-build vite.config.ts
    define: { __RELAY_PORT__: JSON.stringify(backendPort) },
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
    process.stdout.write(`       http://${ip}:${backendPort}/\n`);
  }
  process.stdout.write(
    `\n  Then pick “aiui paint demo” on the iPad. Draw on either side; the ink is shared.\n` +
      `  Switch WebRTC⇄JPEG with the toolbar button, or start at ` +
      `http://localhost:${demoPort}/?video=jpeg\n` +
      `  ⚠️  The backend binds the LAN (${lan}:${backendPort}) and is UNAUTHENTICATED — trusted network only.\n` +
      "  Ctrl-C to stop.\n",
  );

  const shutdown = (): void => {
    backend.dispose();
    httpServer.closeAllConnections?.();
    void Promise.allSettled([
      vite.close(),
      new Promise<void>((r) => httpServer.close(() => r())),
    ]).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
