/**
 * The build-time half of the kit: a Vite config factory for aiui Chrome
 * extensions (CRXJS + Solid), encoding the lessons from the extension spikes
 * (archive/extension-spikes/RESULTS.md):
 *
 *  - **The dev port is pinned and strict.** CRXJS bakes a loader into the dev
 *    `dist/` that dials the dev server, so the port must be stable — but a
 *    squatted port must FAIL LOUDLY, not fall back (the first HMR test was
 *    silently invalidated by a fallback server). If `vite` refuses to start
 *    with "Port N is already in use", find the squatter (`lsof -iTCP:N`) —
 *    do not retry as `vite <port>`: a bare positional arg is a ROOT DIRECTORY.
 *  - **`dist/` has two shapes.** `vite build` writes the production extension;
 *    `vite` (dev) rewrites the same directory into loader stubs that require
 *    the dev server. After switching modes, ALWAYS reload the unpacked
 *    extension in chrome://extensions — the artifact at the path changed
 *    identity.
 *  - **Monorepo source imports need `server.fs.allow`.** Workspace packages
 *    resolve to `src/` (the repo's editable-install convention), which lives
 *    outside the extension package root.
 */
import { crx, defineManifest } from "@crxjs/vite-plugin";
import type { UserConfig } from "vite";
import solid from "vite-plugin-solid";

// Re-exported so extension packages write their manifest.config.ts against the
// kit alone (one import surface; the CRXJS dependency stays the kit's).
export { defineManifest };

/** The manifest shape `crx()` accepts — a defineManifest result qualifies. */
export type WebextManifest = Parameters<typeof crx>[0]["manifest"];

export interface WebextConfigOptions {
  /** The extension manifest (author it with {@link defineManifest}). */
  manifest: WebextManifest;
  /**
   * The pinned dev-server port. Pick one per extension and never share it;
   * strictPort makes collisions fail loudly (see the module doc).
   */
  devPort: number;
  /**
   * Extra roots the dev server may serve files from. The repo root is included
   * by default (workspace packages resolve to their `src/`).
   */
  fsAllow?: string[];
}

/**
 * Build the Vite config for an aiui Chrome extension: Solid transform + CRXJS
 * with the kit's dev-server conventions applied.
 */
export function webextConfig(options: WebextConfigOptions): UserConfig {
  return {
    plugins: [solid(), crx({ manifest: options.manifest })],
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
