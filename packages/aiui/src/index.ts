/**
 * ai ui frontends
 *
 * The `aiui` CLI's library surface. Launch *policy* the CLI applies lives here
 * too, so sibling supervisors can reuse it instead of re-deriving it — the
 * first case is {@link resolveSidecars}, the `aiui claude` logic deciding
 * which session sidecars (e.g. the paint stream) a channel server should host for a
 * project root. The workbench imports it to give its debug channel the same
 * sidecar set a real session would get.
 *
 * @packageDocumentation
 */

// The layered config loader (user config ← project config), for supervisors
// that must obey the same settings a real `aiui claude` launch would — the
// workbench reads `channel.bind` through this so its debug channel binds the
// way the user configured the real one.
export { type AiuiConfig, loadAiuiConfig } from "./util/config";
export {
  type ResolveSidecarsDeps,
  resolveSidecars,
  type SidecarDescriptor,
} from "./util/sidecars";

/** The published package name — handy for smoke tests. */
export const name = "@habemus-papadum/aiui";

/** Greet someone. Replace with your library's real API. */
export function greet(who: string): string {
  return `Hello, ${who}!`;
}
