/**
 * The channel's standard sidecar set, composed by ordinary imports.
 *
 * The channel used to receive its sidecars as JSON *descriptors* on
 * `--sidecars` and dynamic-import each `module` specifier, so it could stay
 * ignorant of every concrete sidecar package. That indirection existed for one
 * reason: those packages were `--no-publish` dev-deps the channel could not
 * declare, so a bare specifier wouldn't resolve from the channel's own
 * node_modules (pnpm's isolated layout). They are published now, so the channel
 * simply depends on them and imports their factories directly — no descriptors,
 * no argv JSON, no absolute-path resolution. The {@link Sidecar} contract stays
 * the mount seam; this module is the single place that names the four
 * implementations.
 *
 * All four are always on. Each rides the channel's one port (no extra process,
 * no extra listener), so hosting one costs nothing, and whether a remote device
 * can actually reach it is the channel *bind*'s decision (`channel.bind`) — the
 * security posture lives there, never in a per-sidecar toggle. A page that
 * never dials a sidecar's endpoint just leaves it idle.
 *
 * `runMcp`/`runServe` take an optional `sidecars: Sidecar[]` and fall back to
 * this set; tests pass their own (often `[]`) to stay hermetic — nothing here
 * spins up a Vite dev server or a CDP bridge unless a real launch asks for it.
 */

import { consoleSidecar } from "@habemus-papadum/aiui-console/sidecar";
import { intentSidecar } from "@habemus-papadum/aiui-intent-client/sidecar";
import { pencilSidecar } from "@habemus-papadum/aiui-pencil/sidecar";
import { barSidecar } from "@habemus-papadum/aiui-remote-bar/sidecar";
import type { Sidecar } from "./sidecar";

/**
 * The four sidecars every channel hosts, built for a project `root` (shown in
 * each remote surface's session list, and used by the intent sidecar to locate
 * the session browser's profile for its CDP bridge). Mount order follows the
 * array; each is path-scoped, and a mount that throws is isolated by
 * `startWebServer` (logged and skipped, never fatal).
 */
export function standardSidecars(root: string): Sidecar[] {
  // The console mounts LAST and adds the channel's own `GET /` → dashboard
  // redirect; every path-scoped sibling above it wins its own routes first.
  return [intentSidecar({ root }), barSidecar({ root }), pencilSidecar({ root }), consoleSidecar()];
}
