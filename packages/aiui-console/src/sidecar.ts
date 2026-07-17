/**
 * The channel **console** as a sidecar — the one page the channel serves at its
 * OWN root (owner, 2026-07-17). Every other page belongs to a frontend process;
 * this is the channel's own dashboard, so it lives here, mounted like the intent
 * and pencil sidecars and riding the channel's one port.
 *
 * It serves a small SolidJS app under `{@link CONSOLE_PREFIX}` (`/__aiui`):
 *  - `/__aiui/`       the dashboard — channel + launch + connected-Chrome info,
 *                     and links to the pencil client, the standalone panel, and
 *                     the trace debugger.
 *  - `/__aiui/debug`  the trace debugger, a client-side route that reuses
 *                     `aiui-trace-ui`'s panes against this same channel.
 *
 * A bare `GET /` on the channel redirects here, so opening the channel URL lands
 * on the dashboard. HOW the app is served is the usual {@link SidecarContext.mode}
 * decision, delegated to `serveClientSurface`: DEV a Vite dev server in
 * middleware mode (HMR over the channel port); PROD the prebuilt `assets/app`
 * bundle. `appType: "spa"` so the two client routes both fall back to the app's
 * `index.html`.
 */

import { fileURLToPath } from "node:url";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import { serveClientSurface } from "@habemus-papadum/aiui-util/web-surface";
import type { Express } from "express";

/** The path prefix the console app mounts under on the channel's server. */
export const CONSOLE_PREFIX = "/__aiui";

/** The prebuilt dashboard bundle's default location (`build:app` writes here). */
const defaultDistDir = (): string => fileURLToPath(new URL("../assets/app", import.meta.url));

export interface ConsoleSidecarOptions {
  /** Override where the prebuilt dashboard bundle is served from (tests). */
  distDir?: string;
}

/** Package the channel console as a {@link Sidecar}. */
export function consoleSidecar(options: ConsoleSidecarOptions = {}): Sidecar {
  return {
    name: "console",
    async mount(app: Express, ctx: SidecarContext): Promise<MountedSidecar> {
      // The channel's own root → the dashboard. An EXACT-match route (not a
      // catch-all), registered by a sidecar that mounts after every channel
      // route, so it never shadows `/health`, `/pencil/`, `/intent/`, ….
      app.get("/", (_req, res) => {
        res.redirect(302, `${CONSOLE_PREFIX}/`);
      });

      const surface = await serveClientSurface(app, {
        mode: ctx.mode,
        prefix: CONSOLE_PREFIX,
        appType: "spa",
        viteRoot: fileURLToPath(new URL("../app", import.meta.url)),
        viteConfigFile: fileURLToPath(new URL("../app/vite.config.ts", import.meta.url)),
        distDir: options.distDir ?? defaultDistDir(),
        notBuiltHint: "pnpm -C packages/aiui-console build:app",
        log: ctx.log,
      });
      ctx.log(`console: mounted at ${CONSOLE_PREFIX}/ (the channel root redirects here)`);

      return {
        handleUpgrade: (req, socket, head) => surface.handleUpgrade?.(req, socket, head) ?? false,
        dispose: () => surface.dispose?.(),
      };
    },
  };
}
