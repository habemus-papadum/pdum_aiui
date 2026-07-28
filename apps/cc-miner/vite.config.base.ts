/**
 * vite.config.base.ts — everything the two hosts share.
 *
 * cc-miner runs in two shells: a browser tab (`pnpm dev`) and an Electron
 * window (`pnpm dev:electron`). Both are Vite DEV SERVERS serving the same
 * renderer over http://localhost — Electron is not a different build, it is a
 * different window pointed at an equivalent server. That is the whole point of
 * this split: the delta between the two configs should stay small enough to
 * read in one screen, and today it is one line (the dev port).
 *
 * So the renderer never asks a build flag which shell it is in — it asks the
 * runtime (`src/host.ts`, which sniffs the Electron user-agent). A build-time
 * `define` would make the two bundles genuinely different, which is the
 * opposite of what we want to be able to claim.
 *
 * This is a FACTORY, not a shared object literal: each config gets its own
 * plugin instances, so the two can never accidentally share mutable plugin
 * state if both are ever loaded in one process.
 */
import aiui from "@habemus-papadum/aiui-source-processor";
import type { UserConfig } from "vite";
import solid from "vite-plugin-solid";
import { duckdbHost } from "./server/vite-plugin";

/**
 * Solid 2.0 (beta) via vite-plugin-solid@next (bundles solid-refresh for HMR).
 *
 * aiui() is the build-time integration (@habemus-papadum/aiui-source-processor): the
 * source-locator compiler pass — JSX gets data-source-loc = "src/…:line:col"
 * (dev-only stamps; production bundles ship clean) and `cell()` call sites get
 * their `{ name, loc }` identity injected in EVERY mode (load-bearing for
 * durable cells) — plus the dev-only sourceRoot seed. Nothing else: no overlay
 * injection, no channel port; connectivity arrives from the intent client
 * (window.__AIUI__ itself is the viz runtime's job, production included).
 *
 * Order matters: aiui() comes BEFORE solid() so the locator's `pre` babel pass
 * stamps JSX before vite-plugin-solid (also `pre`) compiles each element into
 * an opaque template. Same-enforce plugins run in array order.
 */
export function ccMinerConfig(): UserConfig {
  return {
    // duckdbHost() is dev-server middleware only: it exposes `/quack` and
    // `/__duckdb-host` so the page reaches the DuckDB process without ever
    // knowing its port. Both hosts get it, because both serve the app from a
    // Vite dev server.
    plugins: [aiui(), solid(), duckdbHost()],
  };
}
