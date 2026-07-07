/**
 * ai ui frontends
 *
 * The `aiui` CLI's library surface. Launch *policy* the CLI applies lives here
 * too, so sibling supervisors can reuse it instead of re-deriving it — the
 * first case is {@link resolveSidecars}, the `aiui claude` logic deciding
 * which session sidecars (the code reader) a channel server should host for a
 * project root. The workbench imports it to give its debug channel the same
 * sidecar set a real session would get.
 *
 * @packageDocumentation
 */

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
