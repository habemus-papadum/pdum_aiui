/**
 * The build-time half of the kit: a Vite config factory for aiui Chrome
 * extensions (CRXJS + Solid), encoding the lessons from the extension spikes
 * (archive/extension-spikes/RESULTS.md) and from the dev-loop hardening of
 * 2026-07-12:
 *
 *  - **Dev and release write DIFFERENT directories.** `vite` (dev) writes
 *    `dist-dev/` — CRXJS loader stubs that are useless without the dev server;
 *    `vite build` writes `dist/` — the standalone extension that ships. They
 *    used to be the same directory, which meant a `pnpm build` (or any CI-ish
 *    gate that builds the workspace) silently froze a live dev install at that
 *    moment's code, with no error anywhere. Two directories, two lifetimes: a
 *    build can no longer clobber a running dev loop, and each artifact is what
 *    it says it is.
 *  - **The dev artifact stamps itself when it is COMPLETE** (see ./dev-stamp):
 *    `aiui-dev.json` lands last — and only after every file the built manifest
 *    references is verified present ({@link missingManifestFiles}) — while the
 *    same `runId` is served at `/@aiui/dev-run`. Chrome is only ever told to
 *    reload once the stamp exists (`aiui extension dev` / `aiui extension
 *    reload`), and any extension surface can tell "fresh" from "stale" from
 *    "server down" instead of rendering nothing.
 *  - **Know what a CRXJS dev artifact IS, or you will misdiagnose it.** Dev
 *    emits **no entry bundles**: the manifest points at loader stubs and, for
 *    each HTML page, at CRXJS's "loading page" — a placeholder that polls
 *    `/@crx/dev-ready` and reloads, at which point the *service worker* proxies
 *    the extension's own origin to the dev server and the real document is
 *    served from there. So `dist-dev/assets/` holding only `loading-page-*.js`
 *    is correct and expected; the hashed `index.html-*.js` bundles people go
 *    looking for are **production** output. And the corollary that bites: with
 *    the dev server down, every page is stuck on that loading page ("CRXJS DEV
 *    MODE — cannot connect"), which reads as "the extension is broken" and is
 *    in fact "start your dev server".
 *  - **Dev never empties its out dir.** Chrome may read the directory at any
 *    moment; a directory that is briefly *missing its manifest* is a hard
 *    load failure that only a human clicking ⟳ can undo. Overwriting in place
 *    keeps every partial read loadable — and the stamp makes staleness
 *    detectable, so nothing is lost by not wiping.
 *  - **The dev port is pinned and strict.** CRXJS bakes it into the loader
 *    stubs, so it must be stable — but a squatted port must FAIL LOUDLY, not
 *    fall back (the first HMR test was silently invalidated by a fallback
 *    server). If `vite` refuses to start with "Port N is already in use", find
 *    the squatter (`lsof -iTCP:N`) — do not retry as `vite <port>`: a bare
 *    positional arg is a ROOT DIRECTORY.
 *  - **Monorepo source imports need `server.fs.allow`.** Workspace packages
 *    resolve to `src/` (the repo's editable-install convention), which lives
 *    outside the extension package root.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { crx, defineManifest } from "@crxjs/vite-plugin";
import type { Plugin, UserConfig } from "vite";
import solid from "vite-plugin-solid";
// Vite loads this config module through Node itself (its config loader
// externalizes linked workspace packages), so it may not use relative imports —
// Node ESM would need the file extension. The package-internal subpath is the
// repo's convention for exactly this (cf. aiui-dev-overlay's #source-locator).
import { missingManifestFiles } from "#dev-artifact";
import { DEV_RUN_ROUTE, DEV_STAMP_FILE, type DevStamp } from "#dev-stamp";

// Re-exported so extension packages write their manifest.config.ts against the
// kit alone (one import surface; the CRXJS dependency stays the kit's).
export { defineManifest };

/** The manifest shape `crx()` accepts — a defineManifest result qualifies. */
export type WebextManifest = Parameters<typeof crx>[0]["manifest"];

/** Where `vite build` writes the shippable extension. */
export const DEFAULT_OUT_DIR = "dist";

/** Where `vite` (dev) writes the dev-server-dependent extension. */
export const DEFAULT_DEV_OUT_DIR = "dist-dev";

export interface WebextConfigOptions {
  /** The extension manifest (author it with {@link defineManifest}). */
  manifest: WebextManifest;
  /**
   * The pinned dev-server port. Pick one per extension and never share it;
   * strictPort makes collisions fail loudly (see the module doc).
   */
  devPort: number;
  /** Release output directory (default {@link DEFAULT_OUT_DIR}). */
  outDir?: string;
  /** Dev output directory (default {@link DEFAULT_DEV_OUT_DIR}). */
  devOutDir?: string;
  /**
   * Extra roots the dev server may serve files from. The repo root is included
   * by default (workspace packages resolve to their `src/`).
   */
  fsAllow?: string[];
  /**
   * Plugins to run BEFORE the Solid transform — the slot for the aiui
   * compiler (`aiuiDevOverlay({ locator: true, mount: false })`): its `pre`
   * babel pass must stamp JSX and inject `control()`/`cell()` identities
   * before vite-plugin-solid compiles elements into opaque templates (same
   * ordering rule as the app template's vite.config).
   */
  prePlugins?: UserConfig["plugins"];
}

/**
 * Build the Vite config for an aiui Chrome extension: Solid transform + CRXJS
 * with the kit's dev-server conventions applied.
 */
export function webextConfig(options: WebextConfigOptions): UserConfig {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const devOutDir = options.devOutDir ?? DEFAULT_DEV_OUT_DIR;
  return {
    plugins: [
      devArtifact({ devPort: options.devPort, outDir, devOutDir }),
      ...(options.prePlugins ?? []),
      solid(),
      crx({ manifest: options.manifest }),
    ],
    server: {
      port: options.devPort,
      strictPort: true,
      hmr: { clientPort: options.devPort },
      fs: {
        // Repo root: three levels up from packages/<slug>/vite.config.ts. The
        // searchForWorkspaceRoot dance is deliberately avoided — the layout is
        // fixed and explicit beats clever here.
        allow: ["../..", ...(options.fsAllow ?? [])],
      },
    },
  };
}

/**
 * The plugin behind the two bullets above: it routes dev output to its own
 * directory, serves this run's identity, and stamps the artifact once CRXJS
 * has finished writing it.
 *
 * The stamp is deliberately the *last* write and the *only* completeness
 * signal — CRXJS's file writer offers no public "done" hook, so we watch the
 * directory until it stops changing (two identical scans, 250ms apart). That
 * is a heuristic about a filesystem, and it is allowed to be: the cost of
 * being wrong is one extra reload, while the cost of NOT waiting is a Chrome
 * that has cached half an extension.
 */
function devArtifact(opts: { devPort: number; outDir: string; devOutDir: string }): Plugin {
  const stamp: DevStamp = {
    runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    origin: `http://localhost:${opts.devPort}`,
    port: opts.devPort,
    startedAt: new Date().toISOString(),
  };
  let dir = opts.devOutDir;
  let expected = opts.devOutDir;

  return {
    name: "aiui:webext-dev-artifact",
    enforce: "pre",
    config(_config, env) {
      expected = env.command === "serve" ? opts.devOutDir : opts.outDir;
      return {
        build: {
          outDir: expected,
          // Never wipe the dev dir: Chrome may read it at any instant, and a
          // manifest-less directory is an unrecoverable load error (see the
          // module doc). A release build empties `dist/` as usual.
          ...(env.command === "serve" ? { emptyOutDir: false } : {}),
        },
      };
    },
    configResolved(config) {
      dir = absolute(config.build.outDir, config.root);
      // Vite merges plugin `config()` results, and CRXJS's file writer emits
      // into whatever `build.outDir` finally resolved to. If anything (another
      // plugin, a stray user config) overrode us, the dev artifact would be
      // written into the RELEASE directory — freezing a live dev install and
      // leaving the loaded extension unbootable, exactly the disease this split
      // exists to kill. Refuse to run rather than split the artifact in two.
      const want = absolute(expected, config.root);
      if (dir !== want) {
        throw new Error(
          `[aiui-webext] build.outDir resolved to ${dir}, but this ${config.command} must write ` +
            `${want}. Something else in the plugin/config chain is setting outDir — the dev and ` +
            "release artifacts must never share a directory.",
        );
      }
    },
    configureServer(server) {
      // Serve this run's identity to anyone who holds a stamp — the extension's
      // own pages fetch it cross-origin (chrome-extension:// → localhost), so
      // CORS must be open, exactly like CRXJS's own /@crx/dev-ready.
      server.middlewares.use(DEV_RUN_ROUTE, (_req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(stamp));
      });

      server.httpServer?.on("listening", () => {
        void (async () => {
          await settle(dir);

          // The stamp means "this artifact is complete and loadable". Earn it:
          // an extension whose manifest points at files that aren't there loads
          // as a broken shell, and no surface can report why. A dev artifact
          // that cannot boot is worse than no dev artifact — say so, and do NOT
          // stamp, so nothing downstream reloads Chrome onto it.
          const missing = missingManifestFiles(dir);
          if (missing.length) {
            server.config.logger.error(
              `\n  [aiui] the dev artifact in ${dir} is INCOMPLETE — its manifest references ` +
                `files that were never written:\n${missing.map((f) => `    - ${f}`).join("\n")}\n` +
                "  Not stamping it: Chrome would load a broken extension. This is a bug in the\n" +
                "  build (a plugin writing somewhere else?) — do not reload the extension.\n",
            );
            return;
          }

          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, DEV_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
          } catch (error) {
            server.config.logger.error(
              `[aiui] could not stamp the dev artifact in ${dir}: ${String(error)}`,
            );
            return;
          }
          server.config.logger.info(
            `\n  aiui: dev extension written to ${dir} (run ${stamp.runId}).` +
              "\n  Chrome must RELOAD the extension to pick this run up — `aiui extension reload`" +
              "\n  (or use `aiui extension dev`, which does it for you).\n",
          );
        })();
      });
    },
  };
}

function absolute(dir: string, root: string): string {
  return isAbsolute(dir) ? dir : resolve(root, dir);
}

/** Resolve once the directory stops changing (or we give up waiting). */
async function settle(dir: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  while (Date.now() < deadline) {
    await sleep(250);
    const current = await scan(dir);
    // A manifest is the floor: no manifest, no extension, keep waiting.
    if (current && current === previous && existsSync(join(dir, "manifest.json"))) {
      return;
    }
    previous = current;
  }
}

/** A cheap content signature: every file's path + size + mtime, sorted. */
async function scan(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
  } catch {
    return "";
  }
  return entries
    .sort()
    .map((file) => {
      try {
        const s = statSync(file);
        return `${file}:${s.size}:${s.mtimeMs}`;
      } catch {
        return `${file}:gone`;
      }
    })
    .join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
