/**
 * WORKSPACE-INTERNAL seam — channel-discovery/CLI plumbing consumed by the
 * `aiui` launcher and sibling dev scripts. Not a public contract: no semver
 * promise; symbols here may change or vanish in any release.
 *
 * @packageDocumentation
 */

// intent-v1 wire-contract symbols the intent-runtime's cross-package drift
// guards (protocol.test.ts) assert against — not on the root barrel, so the
// guards import them from this no-semver seam instead.
export type { LoweredPromptMessage, SpeechMessage } from "./intent-v1";
export { REALTIME_VOICE_RATE } from "./pcm";
export {
  type AgentsStatus,
  type ChannelListing,
  type EnrichedChannel,
  type ListOptions,
  listChannels,
  listMcpServers,
  type RegistryEntry,
  type RunningServer,
} from "./registry";
export { selectMcpServer } from "./select";
export { projectCacheDir } from "./trace";
// The boot-time vendor-key stash (vendor-key-stash.ts). A SIDECAR that needs a
// vendor key — the intent client's oracle mint — must read it through this, not
// `process.env`: an installed channel resolves the OS vault into the stash and
// deliberately never puts keys in the environment. The stash lives on
// `globalThis` under a `Symbol.for`, so a sidecar's own module instance sees the
// same one the channel's boot resolved.
export { absentKeyPhrase, vendorKey, vendorKeySkipped } from "./vendor-key-stash";
