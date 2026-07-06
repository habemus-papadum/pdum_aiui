/**
 * Where is this process running — CI? over SSH? a machine with no display?
 *
 * Several commands adapt to their surroundings: `aiui claude` leaves the
 * Chrome DevTools MCP off under CI, and `aiui vite` / `pnpm workbench` only
 * auto-open their dev server in the session browser when there is a display
 * to show it on. Those decisions share the detection logic here — kept pure
 * (`env` and `platform` are parameters defaulting to the real ones) so every
 * branch is unit-testable without mutating the test process's own
 * environment.
 *
 * The signals, and why each is trusted:
 *
 * - **CI** — effectively every provider (GitHub Actions, GitLab, CircleCI,
 *   Travis, Buildkite, …) sets `CI=true`. A CI runner may technically have a
 *   display, but nobody is watching it, which is what "headless" means for
 *   the decisions built on this module.
 * - **SSH** — sshd sets `SSH_CONNECTION` and `SSH_CLIENT` in every session
 *   and `SSH_TTY` in interactive ones. Any of them means this shell lives at
 *   the far end of a network connection: a browser launched here would render
 *   on the remote box's display (if it even has one), never in front of the
 *   user. X11 forwarding (`ssh -X`, which sets `DISPLAY`) is deliberately
 *   *not* honored as an exception — it's rare, slow, and almost never where
 *   the user wants a Chrome window; `--aiui-browser`-style force flags are
 *   the escape hatch.
 * - **Linux display** — X11 clients find their server via `DISPLAY`; Wayland
 *   clients via `WAYLAND_DISPLAY`. Neither being set means there is no
 *   compositor to render a window into.
 * - **macOS** — has no display env-var convention; WindowServer is always up
 *   on a booted Mac, so assume a GUI unless SSH says the shell is remote.
 * - **Other platforms** (Windows) likewise have no display env var: assume a
 *   GUI and rely on the CI/SSH signals alone.
 */

/** Truthy `CI` env var, with the conventional "false"/"0" escape hatches. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/**
 * Whether this shell is an SSH session. Checks all three of sshd's markers —
 * `SSH_TTY` is only set for interactive sessions, and `SSH_CONNECTION` /
 * `SSH_CLIENT` can be scrubbed by a paranoid shell profile, so any one of
 * them is taken at its word. Empty values count as unset.
 */
export function isSsh(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSet(env.SSH_CONNECTION) || isSet(env.SSH_TTY) || isSet(env.SSH_CLIENT);
}

/**
 * Why this environment is considered headless — a short human-readable
 * fragment for messages like "detected a headless environment (<reason>)" —
 * or undefined when a GUI is presumed available. The checks run most-explicit
 * first (CI, then SSH, then the platform's display convention); see the
 * module doc for the reasoning behind each signal.
 */
export function headlessReason(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (isCi(env)) {
    return "the CI environment variable is set";
  }
  if (isSsh(env)) {
    return "this is an SSH session";
  }
  if (platform === "linux" && !isSet(env.DISPLAY) && !isSet(env.WAYLAND_DISPLAY)) {
    return "Linux with neither DISPLAY nor WAYLAND_DISPLAY set";
  }
  return undefined;
}

/** {@link headlessReason} as a boolean, for callers that don't print it. */
export function isHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return headlessReason(env, platform) !== undefined;
}

/** Set and non-empty — `VAR=` in a profile shouldn't count as a signal. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
