/**
 * Deciding which **session sidecars** the channel should host for a launch.
 *
 * A sidecar is an extra backend the channel mounts alongside the intent
 * pipeline — the concrete one today is the code reader's server, which the
 * channel serves when the project has an LSP setup or contains well-known
 * languages one can be bootstrapped for. The channel takes no
 * dependency on any sidecar: `aiui claude` hands it a JSON array of
 * {@link SidecarDescriptor}s on `--sidecars`, and the channel dynamic-imports
 * each `module`, calls `mod[export ?? "default"](options)`, and mounts the
 * result (a bad descriptor is logged + skipped there).
 *
 * This module is the CLI's half: a small registry of the sidecars the launcher
 * knows how to construct, plus a pure resolver that decides which are on for a
 * given project root and set of `--aiui-sidecar` / `--aiui-no-sidecar` flags.
 */

import { createRequire } from "node:module";
import {
  detectLanguages as defaultDetectLanguages,
  loadManifest as defaultLoadManifest,
} from "@habemus-papadum/aiui-lsp";

const nodeRequire = createRequire(import.meta.url);

/**
 * The contract the channel's `--sidecars` argument expects, mirrored here so
 * the CLI can emit it. The channel imports `module`, calls its `export` (or
 * `default`) with `options`, and mounts the returned sidecar.
 */
export interface SidecarDescriptor {
  /** Stable identifier, used for `--aiui-sidecar`/`--aiui-no-sidecar` and logs. */
  name: string;
  /** Importable specifier the channel `import()`s (e.g. a package subpath). */
  module: string;
  /** Named export to call as the factory. Defaults to `"default"`. */
  export?: string;
  /** Passed opaquely to the factory (e.g. `{ root: "/proj" }`). */
  options?: unknown;
}

/** Reads an LSP manifest for a project root; a truthy return means one exists. */
type LoadManifest = (projectRoot: string) => unknown;

/** Detects a project's well-known languages (the LSP bootstrap's own detector). */
type DetectLanguages = (projectRoot: string) => string[];

/** Resolves a package specifier to an absolute path the channel can `import()`. */
type ResolveModule = (specifier: string) => string;

/** Injectable seams, so the resolver is unit-testable without on-disk state. */
export interface ResolveSidecarsDeps {
  /** Defaults to `@habemus-papadum/aiui-lsp`'s `loadManifest`. */
  loadManifest?: LoadManifest;
  /** Defaults to `@habemus-papadum/aiui-lsp`'s `detectLanguages`. */
  detectLanguages?: DetectLanguages;
  /**
   * Resolves a sidecar's package specifier to an ABSOLUTE path. Defaults to
   * `createRequire(import.meta.url).resolve`. This matters: the channel
   * dynamic-imports the descriptor's `module`, but it does NOT depend on any
   * sidecar package — so a bare specifier resolves from the channel's own
   * node_modules and fails (pnpm's isolated layout). Resolving here (from the
   * `aiui` CLI, which DOES depend on the sidecar package) to an absolute path
   * makes the import work in both the source-first workspace and an install.
   */
  resolveModule?: ResolveModule;
  /** Warning sink for a sidecar that had to be dropped (defaults to stderr). */
  log?: (message: string) => void;
}

/** The resolved (defaulted) detection seams handed to `autoEnable`. */
interface DetectDeps {
  loadManifest: LoadManifest;
  detectLanguages: DetectLanguages;
}

/** A sidecar the CLI knows how to enable and construct, keyed by name. */
interface KnownSidecar {
  name: string;
  /** Whether this sidecar auto-enables for the given project root. */
  autoEnable: (root: string, deps: DetectDeps) => boolean;
  /** Build the descriptor the channel will mount for this root. */
  descriptor: (root: string, resolveModule: ResolveModule) => SidecarDescriptor;
}

/**
 * The registry of sidecars the launcher can enable. Emit order follows this
 * list, so the resolver's output is stable regardless of flag order. Today it
 * holds only the code reader, auto-on whenever the project has an LSP setup OR
 * contains well-known languages the reader's backend can bootstrap servers for.
 * (Manifest-only detection was a chicken-and-egg: the bootstrap that CREATES a
 * manifest lives in the backend, which only runs if the sidecar mounts — so a
 * fresh project could never get the reader through `aiui claude`.)
 */
const KNOWN_SIDECARS: KnownSidecar[] = [
  {
    name: "code",
    autoEnable: (root, { loadManifest, detectLanguages }) =>
      Boolean(loadManifest(root)) || detectLanguages(root).length > 0,
    descriptor: (root, resolveModule) => ({
      name: "code",
      module: resolveModule("@habemus-papadum/aiui-code-server/sidecar"),
      export: "codeReaderSidecar",
      options: { root },
    }),
  },
];

/**
 * Decide which session sidecars to host for `root`.
 *
 * Starts from the auto-detected set (each known sidecar whose `autoEnable`
 * predicate is truthy for this root), then applies the flags: `opts.enable`
 * force-adds a known sidecar by name even when it wouldn't auto-detect, and
 * `opts.disable` removes one. Disable wins over enable. Enable names the CLI
 * doesn't know how to construct are ignored (the launcher can only build the
 * sidecars in {@link KNOWN_SIDECARS}). Descriptors come back in the registry's
 * stable order.
 */
export function resolveSidecars(
  root: string,
  opts: { enable: string[]; disable: string[] },
  deps: ResolveSidecarsDeps = {},
): SidecarDescriptor[] {
  const loadManifest = deps.loadManifest ?? defaultLoadManifest;
  const detectLanguages = deps.detectLanguages ?? defaultDetectLanguages;
  const resolveModule =
    deps.resolveModule ?? ((specifier: string) => nodeRequire.resolve(specifier));
  const log =
    deps.log ?? ((message: string) => process.stderr.write(`[aiui] warning: ${message}\n`));
  const enabled = new Set<string>();

  // Auto-detected sidecars. A throwing detector (e.g. loadManifest on a corrupt
  // manifest.json) must not kill the launch — warn and treat as not detected.
  for (const known of KNOWN_SIDECARS) {
    try {
      if (known.autoEnable(root, { loadManifest, detectLanguages })) {
        enabled.add(known.name);
      }
    } catch (err) {
      log(
        `sidecar "${known.name}" auto-detect failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Force-enable, but only sidecars the CLI knows how to construct.
  for (const name of opts.enable) {
    if (KNOWN_SIDECARS.some((k) => k.name === name)) {
      enabled.add(name);
    }
  }
  // Disable wins over enable.
  for (const name of opts.disable) {
    enabled.delete(name);
  }

  return KNOWN_SIDECARS.filter((k) => enabled.has(k.name))
    .map((k) => {
      try {
        return k.descriptor(root, resolveModule);
      } catch (err) {
        // The sidecar's package isn't resolvable (e.g. not installed) — skip it
        // rather than failing the whole launch, but say so: silently dropping it
        // would surface as "the reader is mysteriously absent".
        log(
          `sidecar "${k.name}" disabled — its module failed to resolve: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      }
    })
    .filter((d): d is SidecarDescriptor => d !== undefined);
}
