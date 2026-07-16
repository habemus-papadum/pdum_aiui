/**
 * serve-client-surface — the one place a channel sidecar decides HOW to serve
 * its web client, by {@link SidecarContext.mode}.
 *
 *  - **dev**  → a Vite dev server in middleware mode (HMR, source-first), rooted
 *    at the sidecar package's own Vite config. HMR rides the channel's ONE port
 *    via a never-listening shim: the channel offers each unclaimed websocket
 *    upgrade to the sidecar, and the returned {@link ClientSurface.handleUpgrade}
 *    forwards this surface's HMR path into the shim, from which Vite completes
 *    the handshake.
 *  - **prod** → static file serving from a prebuilt bundle. No Vite at runtime;
 *    an installed package needs neither Vite nor the dev toolchain.
 *
 * Extracted from the intent sidecar so every HTML-serving sidecar (intent,
 * pencil, …) serves the same way, differing only by `(viteRoot, distDir)`. Vite
 * is imported LAZILY and only in dev, so `import("vite")` is never reached in a
 * prod install (where it isn't present).
 *
 * The helper only owns the *client-serving* middleware; a sidecar registers its
 * own routes (a discovery `/info`, a proxy) on the app BEFORE calling this so
 * they take precedence, and composes the returned `handleUpgrade`/`dispose` with
 * its own (e.g. the intent sidecar's CDP bridge).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, normalize, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { Express } from "express";

export interface ServeClientSurfaceOptions {
  /** Dev serves from Vite; prod serves the prebuilt static bundle. */
  mode: "dev" | "prod";
  /** Base path the client mounts under, no trailing slash (e.g. `"/intent"`). */
  prefix: string;
  /**
   * Dev only: the directory Vite roots at. Its own `vite.config` is auto-resolved
   * from here (plugins, entry html) unless {@link viteConfigFile} overrides.
   * Required in dev.
   */
  viteRoot?: string;
  /**
   * Dev only: an explicit Vite config file, when the root's auto-resolved config
   * isn't the one to serve with (e.g. pencil's `lab/vite.config.ts` mounts a
   * whole lab rig; the sidecar wants the client-only build config instead).
   * Omitted → Vite auto-resolves from {@link viteRoot}.
   */
  viteConfigFile?: string;
  /**
   * Dev only: the html file served at the base (`prefix/`), when it isn't
   * `index.html` (Vite's convention). E.g. pencil's client entry is
   * `client.html`; a request to `/pencil/` is rewritten to `/pencil/client.html`
   * before Vite. Prod always serves `<distDir>/index.html` (the built artifact).
   */
  devEntry?: string;
  /** Prod only: the prebuilt static bundle served under `prefix`. Required in prod. */
  distDir?: string;
  /**
   * Vite's `appType` in dev (default `"mpa"`, matching the intent panel). Use
   * `"spa"` for a single-page client that wants an index.html fallback.
   */
  appType?: "mpa" | "spa";
  /** Relative HMR websocket path segment under `prefix` (default `"hmr"`). */
  hmrPath?: string;
  /** Prod: shown (503) when `distDir` has no `index.html` — the build command to run. */
  notBuiltHint?: string;
  /** Diagnostic sink (stderr). */
  log?: (message: string) => void;
}

/** What a sidecar composes into its {@link MountedSidecar} handle. */
export interface ClientSurface {
  /** Claim this surface's HMR upgrade (dev only); `false` otherwise. */
  handleUpgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Close the Vite server + HMR shim (dev); a no-op in prod. */
  dispose?(): void | Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Mount a client surface on `app` under `options.prefix`, choosing Vite (dev) or
 * static serving (prod). Returns the HMR upgrade handler + disposer to compose
 * into the sidecar's {@link MountedSidecar}.
 */
export async function serveClientSurface(
  app: Express,
  options: ServeClientSurfaceOptions,
): Promise<ClientSurface> {
  const log = options.log ?? (() => {});
  return options.mode === "dev" ? serveDev(app, options, log) : serveProd(app, options, log);
}

async function serveDev(
  app: Express,
  options: ServeClientSurfaceOptions,
  log: (message: string) => void,
): Promise<ClientSurface> {
  if (options.viteRoot === undefined) {
    throw new Error(`serveClientSurface("${options.prefix}"): dev mode needs a viteRoot`);
  }
  // Lazy + dev-only: a prod install has no Vite, and never reaches this branch.
  const { createServer } = await import("vite");
  const hmrShim = createHttpServer();
  const hmrSeg = options.hmrPath ?? "hmr";
  // Vite composes the HMR ws path as base + hmr.path, so hand it the RELATIVE
  // segment (`hmr`) — a full `/prefix/hmr` here makes the client dial
  // `/prefix/prefix/hmr`. The client ends up dialing `${prefix}/${hmrSeg}`.
  const vite = await createServer({
    root: options.viteRoot,
    // Explicit config when the root's auto-resolved one isn't the serving config
    // (pencil); `undefined` keeps Vite's auto-resolution (intent).
    configFile: options.viteConfigFile,
    base: `${options.prefix}/`,
    appType: options.appType ?? "mpa",
    server: { middlewareMode: true, hmr: { server: hmrShim, path: hmrSeg } },
    clearScreen: false,
    logLevel: "warn",
  });
  // One gated middleware, because this Vite server SHARES the channel's Express
  // app with sibling sidecars mounted after it. Vite's stack ends in a terminal
  // 404 (appType mpa/spa) that answers every request it can't serve instead of
  // calling next() — so an ungated `app.use(vite.middlewares)` would swallow all
  // downstream sidecars' routes (found live: intent starved /bar and /pencil).
  // The gate hands Vite ONLY requests under our prefix (every dev URL it emits
  // — `@vite/client`, `/@fs`, dep-optimizer, source — is base-prefixed, so this
  // loses nothing) and lets everything else fall through untouched.
  const { prefix } = options;
  const devEntry = options.devEntry ?? "index.html";
  const entry = `${prefix}/${devEntry}`;
  app.use((req, res, next) => {
    const [path, query] = (req.url ?? "").split("?");
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      next(); // not ours — a sibling sidecar or the channel owns it
      return;
    }
    // When the base entry isn't `index.html` (Vite's convention), point the bare
    // mount path at it so Vite transforms and serves that html. Assets keep
    // their own URLs.
    if (devEntry !== "index.html" && (path === prefix || path === `${prefix}/`)) {
      req.url = query !== undefined ? `${entry}?${query}` : entry;
    }
    vite.middlewares(req, res, next);
  });
  log(`${prefix}: vite middleware (dev, source-first, HMR) rooted at ${options.viteRoot}`);

  const hmrFull = `${options.prefix}/${hmrSeg}`;
  return {
    handleUpgrade: (req, socket, head) => {
      if ((req.url ?? "").split("?")[0] === hmrFull) {
        hmrShim.emit("upgrade", req, socket, head);
        return true;
      }
      return false;
    },
    dispose: async () => {
      await vite.close();
      hmrShim.close();
    },
  };
}

function serveProd(
  app: Express,
  options: ServeClientSurfaceOptions,
  log: (message: string) => void,
): ClientSurface {
  if (options.distDir === undefined) {
    throw new Error(`serveClientSurface("${options.prefix}"): prod mode needs a distDir`);
  }
  const root = resolve(options.distDir);
  const { prefix } = options;

  // Hand-rolled rather than `express.static`: the helper receives an Express app
  // but must not import Express at runtime (it would resolve a second copy
  // beside the channel's own), and a few lines with a traversal guard is cheaper
  // than that risk. When the bundle hasn't been built, `<prefix>/` answers 503
  // with the build command, not a bare 404 that reads as "the sidecar is broken".
  const serve = (req: IncomingMessage, res: ServerResponse): boolean => {
    if ((req.method ?? "GET") !== "GET") {
      return false;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      return false;
    }
    let rel = pathname === prefix ? "/" : pathname.slice(prefix.length);
    if (rel === "/" || rel === "") {
      rel = "/index.html";
    }
    const file = resolve(join(root, normalize(rel)));
    if (!file.startsWith(root)) {
      res.statusCode = 403;
      res.end();
      return true; // a traversal attempt is OURS to refuse, not to pass along
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (rel === "/index.html") {
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          `The ${prefix} client has not been built.\n\n` +
            (options.notBuiltHint ? `  ${options.notBuiltHint}\n\n` : "") +
            `(serving from ${root})\n`,
        );
        return true;
      }
      return false; // an unknown asset path may belong to someone else
    }
    const dot = file.lastIndexOf(".");
    const type = dot >= 0 ? MIME[file.slice(dot)] : undefined;
    res.statusCode = 200;
    if (type) {
      res.setHeader("Content-Type", type);
    }
    res.end(readFileSync(file));
    return true;
  };

  app.use((req, res, next) => {
    if (!serve(req, res)) {
      next();
    }
  });
  log(`${prefix}: static bundle (prod) from ${root}`);
  return {};
}
