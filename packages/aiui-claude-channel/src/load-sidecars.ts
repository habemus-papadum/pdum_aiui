/**
 * Sidecar descriptor loading — how the launcher tells this channel which session
 * sidecars to host **without the channel depending on any concrete sidecar**.
 *
 * The launcher (`aiui claude`) passes a JSON array of {@link SidecarDescriptor}s
 * on `aiui-claude-channel mcp --sidecars <json>`. Each names an importable module
 * and the export to call to build a {@link Sidecar}; the channel dynamic-imports
 * whatever specifier it's told, calls the factory with the descriptor's opaque
 * `options`, and hands the results to `startWebServer({ sidecars })`. The channel
 * never imports or references a concrete sidecar (e.g. the code reader) — the
 * `module` string is entirely the caller's choice.
 *
 * Everything here is best-effort and non-fatal: a descriptor that fails to
 * import, whose export isn't callable, that throws, or that returns something
 * that isn't a Sidecar is **logged and skipped**. One bad sidecar must not sink
 * the session. And, like the rest of the web backend, logging goes to stderr —
 * the `mcp` command's stdout carries the MCP protocol.
 */
import type { Sidecar } from "./sidecar";

/**
 * A launcher-supplied recipe for one session sidecar. The channel resolves it at
 * startup: dynamic-import {@link module}, read {@link export} (default
 * `"default"`), call it with {@link options}, take the returned {@link Sidecar}.
 */
export interface SidecarDescriptor {
  /** Stable identifier, used only in logs (e.g. `"code"`). */
  name: string;
  /**
   * An importable specifier the channel `import()`s — a package subpath the
   * caller controls (e.g. `"@scope/some-sidecar/sidecar"`). The channel takes no
   * dependency on it and hardcodes no sidecar name; it imports whatever string
   * it's handed.
   */
  module: string;
  /** Named export to call as the factory. Defaults to `"default"`. */
  export?: string;
  /** Passed opaquely to the factory (e.g. `{ root: "/proj" }`). */
  options?: unknown;
}

/** How {@link loadSidecars} resolves a descriptor's `module` to its exports. */
export type SidecarImport = (specifier: string) => Promise<Record<string, unknown>>;

/** Options for {@link loadSidecars}. */
export interface LoadSidecarsOptions {
  /** Log sink (stderr — never stdout, which the `mcp` command's protocol owns). */
  log?: (message: string) => void;
  /**
   * Module resolver, injected so tests can supply a fixture factory without a
   * real package on disk. Defaults to the runtime dynamic `import()`.
   */
  import?: SidecarImport;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const defaultLog = (message: string): void => {
  process.stderr.write(`[aiui-channel] ${message}\n`);
};

/** Structural check that a factory returned something usable as a {@link Sidecar}. */
const isSidecar = (value: unknown): value is Sidecar =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { name?: unknown }).name === "string" &&
  typeof (value as { mount?: unknown }).mount === "function";

/** Structural check for a well-formed {@link SidecarDescriptor} in parsed JSON. */
const isDescriptor = (value: unknown): value is SidecarDescriptor =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { name?: unknown }).name === "string" &&
  typeof (value as { module?: unknown }).module === "string";

/**
 * Resolve each descriptor into a live {@link Sidecar}, ready for
 * `startWebServer({ sidecars })`.
 *
 * For every descriptor: dynamic-import its `module`, read the named `export`
 * (default `"default"`), call it with `options`, and keep the returned Sidecar.
 * Any failure along the way — import rejects, export isn't a function, factory
 * throws, factory returns a non-Sidecar — is logged and the descriptor skipped,
 * never fatal. Returns only the sidecars that resolved cleanly, in input order.
 */
export async function loadSidecars(
  descriptors: SidecarDescriptor[],
  opts: LoadSidecarsOptions = {},
): Promise<Sidecar[]> {
  const log = opts.log ?? defaultLog;
  const importModule: SidecarImport = opts.import ?? ((specifier) => import(specifier));
  const sidecars: Sidecar[] = [];
  for (const descriptor of descriptors) {
    const exportName = descriptor.export ?? "default";
    try {
      const mod = await importModule(descriptor.module);
      const factory = mod[exportName];
      if (typeof factory !== "function") {
        log(
          `sidecar "${descriptor.name}" skipped — ${descriptor.module} has no callable export "${exportName}"`,
        );
        continue;
      }
      const built: unknown = await (factory as (options: unknown) => unknown)(descriptor.options);
      if (!isSidecar(built)) {
        log(
          `sidecar "${descriptor.name}" skipped — ${descriptor.module}#${exportName} did not return a Sidecar`,
        );
        continue;
      }
      sidecars.push(built);
      log(`sidecar "${descriptor.name}" loaded from ${descriptor.module}`);
    } catch (err) {
      log(`sidecar "${descriptor.name}" failed to load: ${errorMessage(err)}`);
    }
  }
  return sidecars;
}

/**
 * Parse a `--sidecars` JSON argument into descriptors, tolerantly. Malformed
 * JSON, a non-array top level, or an entry missing a string `name`/`module` are
 * logged and dropped (returning `[]` or the good entries) — never thrown, so a
 * bad value can't stop the MCP server from starting.
 */
export function parseSidecarDescriptors(
  json: string,
  opts: { log?: (message: string) => void } = {},
): SidecarDescriptor[] {
  const log = opts.log ?? defaultLog;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    log("ignoring malformed --sidecars JSON");
    return [];
  }
  if (!Array.isArray(parsed)) {
    log("ignoring --sidecars — expected a JSON array of descriptors");
    return [];
  }
  const descriptors: SidecarDescriptor[] = [];
  for (const entry of parsed) {
    if (isDescriptor(entry)) {
      descriptors.push(entry);
    } else {
      log("ignoring a --sidecars entry that lacks a string `name`/`module`");
    }
  }
  return descriptors;
}
