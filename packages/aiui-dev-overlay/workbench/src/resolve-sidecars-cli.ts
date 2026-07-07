/**
 * The sidecar resolver's runner: `resolve-sidecars-cli.ts <project-root>`.
 *
 * Decides which session sidecars the workbench's debug channel should host —
 * by reusing `aiui claude`'s own policy (`resolveSidecars` from the aiui
 * package) rather than re-deriving it here. Same detection, same descriptors,
 * so the workbench's channel serves exactly what a real session's would.
 *
 * Spawned by vite.config.ts (via tsx, the same source-first trick as the
 * channel server) rather than imported: Vite bundles a config file but
 * *externalizes* every bare import, so workspace packages reached from the
 * config graph get loaded by plain Node — which can't resolve the linked TS
 * sources' extensionless relative imports.
 *
 * stdout is exactly one line — the resolved `SidecarDescriptor[]` as JSON,
 * ready for `serve --sidecars`. Warnings (a corrupt manifest, an unresolvable
 * sidecar package) go to stderr, `resolveSidecars`'s default sink, for the
 * parent to `[channel]`-prefix.
 */
import { resolveSidecars } from "@habemus-papadum/aiui";

const [root] = process.argv.slice(2);
if (!root) {
  console.error("usage: resolve-sidecars-cli.ts <project-root>");
  process.exit(2);
}

process.stdout.write(`${JSON.stringify(resolveSidecars(root, { enable: [], disable: [] }))}\n`);
