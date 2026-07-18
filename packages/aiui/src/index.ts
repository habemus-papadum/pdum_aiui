/**
 * ai ui frontends
 *
 * The `aiui` CLI's library surface. Launch *policy* the CLI applies lives here
 * too, so sibling supervisors can reuse it instead of re-deriving it — e.g. the
 * layered config loader below, so a debug-channel supervisor binds the channel
 * the same way a real `aiui claude` launch would.
 *
 * @packageDocumentation
 */

// The layered config loader (user config ← project config), for supervisors
// that must obey the same settings a real `aiui claude` launch would — the
// supervisors read `channel.bind` through this so a debug channel binds the
// way the user configured the real one.
export { type AiuiConfig, loadAiuiConfig } from "./util/config";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui";
