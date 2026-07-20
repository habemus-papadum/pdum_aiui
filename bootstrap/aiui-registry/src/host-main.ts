/**
 * Entry point of the COMPILED native-messaging host (bun `--compile`; see
 * scripts/build-binaries.mjs). Chrome spawns it via the wrapper script, which
 * bakes the machine-specific facts as env:
 *
 *  - `AIUI_CLAUDE_BIN` — absolute path to the Claude Code binary (Chrome's
 *    minimal env has no user PATH, so name resolution can't work here).
 *    Absent → PATH resolution is attempted and fails loud as "claude-missing".
 *  - `AIUI_CACHE` — optional cache-root override (tests, unusual setups).
 */
import { runNativeHost } from "./host.ts";
import { listChannels } from "./list.ts";

await runNativeHost({
  list: () =>
    listChannels({
      client: "native-host",
      ...(process.env.AIUI_CLAUDE_BIN ? { claudePath: process.env.AIUI_CLAUDE_BIN } : {}),
    }),
});
