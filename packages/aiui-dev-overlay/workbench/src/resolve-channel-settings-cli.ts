/**
 * The channel-settings resolver: `resolve-channel-settings-cli.ts <project-root>`.
 *
 * Decides how the workbench's debug channel should launch — by reusing `aiui
 * claude`'s own policy rather than re-deriving it here:
 *
 *  - **sidecars**: `resolveSidecars` (same detection, same descriptors, so the
 *    workbench's channel serves exactly what a real session's would);
 *  - **bind**: the user's `channel.bind` from the layered aiui config
 *    (`loadAiuiConfig`) — `"host"` puts the channel on 0.0.0.0 so a LAN iPad
 *    can reach the paint page, exactly as it would under a real `aiui claude`
 *    launch. The workbench never forces this; it only obeys the config.
 *
 * Spawned by vite.config.ts (via tsx, the same source-first trick as the
 * channel server) rather than imported: Vite bundles a config file but
 * *externalizes* every bare import, so workspace packages reached from the
 * config graph get loaded by plain Node — which can't resolve the linked TS
 * sources' extensionless relative imports.
 *
 * stdout is exactly one line of JSON:
 * `{ "sidecars": SidecarDescriptor[], "bind": "loopback" | "host" }`.
 * Warnings (a corrupt manifest, an unresolvable sidecar package) go to
 * stderr, `resolveSidecars`'s default sink, for the parent to
 * `[channel]`-prefix.
 */
import { loadAiuiConfig, resolveSidecars } from "@habemus-papadum/aiui";

const [root] = process.argv.slice(2);
if (!root) {
  console.error("usage: resolve-channel-settings-cli.ts <project-root>");
  process.exit(2);
}

const sidecars = resolveSidecars(root, { enable: [], disable: [] });
const bind = loadAiuiConfig(root).channel?.bind === "host" ? "host" : "loopback";
process.stdout.write(`${JSON.stringify({ sidecars, bind })}\n`);
