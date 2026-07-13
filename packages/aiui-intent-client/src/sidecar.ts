/**
 * The detached panel as a **channel sidecar** — the Phase-2 endgame: the
 * channel SERVES the intent client, so the page's origin IS the channel and
 * discovery disappears (session.ts's same-origin resolution takes over; no
 * `?channel=` needed, no port probing, no native host — ever).
 *
 * Mounted under `/intent/` on the channel's one port, exactly like the iPad
 * paint page under `/paint/` (the standing exception to "the channel serves
 * no HTML": a page whose frontend process IS the channel). Serving is a Vite
 * dev server in middleware mode rooted at this package — source-first, like
 * everything in the workspace; a static dist build can replace it at
 * packaging time (Phase 4). HMR is off through the channel (the standalone
 * `pnpm dev` page remains the hot-iteration surface); the channel-served
 * page is the stable, always-there one.
 *
 * Reachability follows the channel's bind decision (`channel.bind`), same
 * as paint — the sidecar adds no listener and no new posture.
 */

import { fileURLToPath } from "node:url";
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";

/** The path prefix the panel lives under on the channel's server. */
export const INTENT_PREFIX = "/intent";

export interface IntentSidecarOptions {
  /** Project root (unused today; future: per-project panel state). */
  root?: string;
}

/** Package the detached panel as a channel {@link Sidecar}. */
export function intentSidecar(_options: IntentSidecarOptions = {}): Sidecar {
  return {
    name: "intent",
    async mount(app: Express, ctx: SidecarContext): Promise<MountedSidecar> {
      // Vite resolves this package's own vite.config.ts (solid plugin et al).
      // `base` scopes the middlewares to /intent/* — requests outside the
      // base fall through to the channel's own routes, per the sidecar rule.
      const { createServer } = await import("vite");
      const packageRoot = fileURLToPath(new URL("..", import.meta.url));
      const vite = await createServer({
        root: packageRoot,
        base: `${INTENT_PREFIX}/`,
        appType: "mpa",
        server: { middlewareMode: true, hmr: false },
        clearScreen: false,
        logLevel: "warn",
      });
      app.use(vite.middlewares);
      ctx.log(`intent client mounted at ${INTENT_PREFIX}/ (vite middleware, source-first)`);
      return {
        dispose: () => vite.close(),
      };
    },
  };
}
