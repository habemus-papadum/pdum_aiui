/**
 * The workbench's fixed port layout. `pnpm workbench` starts two servers,
 * and both bind a **known** loopback port — you usually run
 * exactly one workbench, so a bookmark, a curl, or a DevTools "open
 * 127.0.0.1:492xx" should never require reading startup logs first:
 *
 *   49222  workbench UI (the Vite server that owns the channel)   WORKBENCH_PORT
 *   49223  debug channel server (`aiui-claude-channel serve`)     WORKBENCH_CHANNEL_PORT
 *
 * The block sits in the IANA dynamic/private range (49152–65535), high enough
 * to dodge the dev-server folk ports (3000, 5173, 8080…) and anything a
 * registry would assign by name. Predictability over politeness is the whole
 * point: the Vite servers run `strictPort` and the channel gets `--port`, so
 * a taken port is a loud, early failure with a hint (see
 * {@link portTakenHint}) rather than a silent drift to a port nobody knows.
 * The env overrides (same `WORKBENCH_*` convention as `WORKBENCH_RECORD`)
 * exist for the one legitimate collision — you really do want two workbenches
 * at once — and for CI-ish environments where the block is spoken for.
 *
 * Note the fixed values are *requests*, not truths: the channel announces the
 * port it actually bound on its `AIUI_CHANNEL_SERVE` ready line (see
 * serve-ready.ts), and the workbench keeps reading it from there — with
 * strictPort semantics the two can only agree or fail, but the handshake
 * stays the single source of truth.
 */

/** Which of the two servers a port belongs to. */
export type WorkbenchServerId = "workbench" | "channel";

export interface WorkbenchPorts {
  /** The workbench UI's own Vite server. */
  workbench: number;
  /** The spawned debug channel server (`aiui-claude-channel serve --port …`). */
  channel: number;
}

/** The env var that overrides each server's port. */
export const WORKBENCH_PORT_ENV: Record<WorkbenchServerId, string> = {
  workbench: "WORKBENCH_PORT",
  channel: "WORKBENCH_CHANNEL_PORT",
};

/** The default layout: two consecutive ports, one glance to know them all. */
export const WORKBENCH_PORT_DEFAULTS: WorkbenchPorts = {
  workbench: 49222,
  channel: 49223,
};

/** A strictly-decimal integer in the TCP port range [1, 65535]. */
const parseEnvPort = (raw: string): number | undefined => {
  const port = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
};

/**
 * Resolve the port layout from the environment: each `WORKBENCH_*` var, when
 * set, overrides its default. A set-but-invalid value **throws** (naming the
 * var) instead of falling back — a typo'd override that silently reverted to
 * 49222 would defeat the predictability this file exists for.
 *
 * `env` is injectable for tests; production callers pass nothing.
 */
export function resolveWorkbenchPorts(
  env: Record<string, string | undefined> = process.env,
): WorkbenchPorts {
  const resolved = { ...WORKBENCH_PORT_DEFAULTS };
  for (const id of Object.keys(WORKBENCH_PORT_ENV) as WorkbenchServerId[]) {
    const envVar = WORKBENCH_PORT_ENV[id];
    const raw = env[envVar];
    if (raw === undefined || raw === "") {
      continue;
    }
    const port = parseEnvPort(raw);
    if (port === undefined) {
      throw new Error(
        `${envVar}=${JSON.stringify(raw)} is not a valid port — expected an integer between 1 and 65535`,
      );
    }
    resolved[id] = port;
  }
  return resolved;
}

/**
 * The one line a human needs when a fixed port turns out to be taken: what
 * failed, the most likely culprit, and the override that resolves a genuine
 * two-workbench setup. Printed alongside (not instead of) the underlying
 * error, so the EADDRINUSE detail is still there for the curious.
 */
export function portTakenHint(id: WorkbenchServerId, ports: WorkbenchPorts): string {
  const what = { workbench: "workbench UI", channel: "debug channel" }[id];
  return (
    `${what} port ${ports[id]} is already in use — is another workbench running? ` +
    `Stop it, or run this one elsewhere with ${WORKBENCH_PORT_ENV[id]}=<port>.`
  );
}

/** Duck-type an unknown error as "the port was taken" (Node or Vite flavored). */
export function isPortTakenError(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
    return true;
  }
  // Vite's strictPort rejection is a plain Error("Port <n> is already in use");
  // the channel CLI's message says "already in use" too. Match the phrase.
  return error instanceof Error && /already in use/i.test(error.message);
}
