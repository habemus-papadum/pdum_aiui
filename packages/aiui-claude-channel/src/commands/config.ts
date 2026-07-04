/**
 * Placeholder channel configuration.
 *
 * Nothing interesting yet — this is a scaffold describing a one-way channel
 * sourced from aiui. Exported so it can be imported and asserted on in tests.
 */
export const CHANNEL_CONFIG = {
  name: "aiui-claude-channel",
  channel: { source: "aiui", mode: "one-way" },
  server: {},
} as const;

/** Print the channel config as pretty-printed JSON to stdout. */
export function runConfig(): void {
  console.log(JSON.stringify(CHANNEL_CONFIG, null, 2));
}
