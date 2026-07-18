/**
 * dev.ts — the standalone dev-page launcher. `pnpm dev`.
 *
 * The plain page (index.html → src/ui/main.tsx) is served on Vite's OWN origin,
 * so it cannot discover a channel by origin the way the channel-served
 * `/intent/` page does (session.ts `resolveChannelPort`). Left to itself it
 * drops to the fake (offline) tier — the panel with the simulate buttons and no
 * turn preview / traces.
 *
 * This closes that gap the way `aiui vite` does: pick a running channel from the
 * shared registry, inject its port as `VITE_AIUI_PORT`, then start Vite — so the
 * page boots into the same CDP/channel tier as `/intent/`, while keeping full
 * HMR on its own origin.
 *
 *  - **No channel running** → start Vite anyway; the fake tier is the right
 *    place to iterate the offline UI.
 *  - **One real channel** → taken without prompting (a lone *debug* channel
 *    still prompts — driving a server that answers to nobody is a choice).
 *  - **Several** → the same selector `aiui vite` and `quick` use.
 *  - **`VITE_AIUI_PORT` already set** → honored as-is, no prompt (the
 *    non-interactive escape hatch, e.g. `VITE_AIUI_PORT=49317 pnpm dev`).
 */

import { listMcpServers, selectMcpServer } from "@habemus-papadum/aiui-claude-channel/internal";
import { createServer } from "vite";

if (process.env.VITE_AIUI_PORT) {
  console.info(
    `aiui: dev page will drive channel :${process.env.VITE_AIUI_PORT} (from VITE_AIUI_PORT)`,
  );
} else {
  const servers = listMcpServers();
  if (servers.length > 0) {
    const chosen = await selectMcpServer(servers);
    process.env.VITE_AIUI_PORT = String(chosen.port);
    console.info(
      `aiui: dev page will drive channel "${chosen.tag}" on :${chosen.port} (${chosen.cwd})`,
    );
  } else {
    console.info(
      "aiui: no channel running — the dev page starts in the fake (offline) tier.\n" +
        "      start one (`aiui claude`, or `pnpm test-app:channel`) and re-run to drive it.",
    );
  }
}

// createServer picks up this package's vite.config.ts from the cwd (pnpm runs
// the script in the package dir); the injected env above is read at page load
// by resolveChannelPort via import.meta.env.VITE_AIUI_PORT.
const server = await createServer();
await server.listen();
server.printUrls();
server.bindCLIShortcuts({ print: true });
