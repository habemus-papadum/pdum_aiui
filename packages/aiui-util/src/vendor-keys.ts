/**
 * Vendor API keys: the registry, the user's per-provider decisions, and the
 * one resolver every consumer goes through (docs/proposals — the os-vault
 * promotion, 2026-07-20).
 *
 * The split of responsibilities:
 *  - the **vault** (./vault) holds the secret bytes;
 *  - the **user config** (`<user cache>/config.json`, the aiui CLI's file)
 *    holds the per-provider DECISION — `"vault"` (in use, key at rest in the
 *    OS vault) or `"skip"` (don't use this provider); absence means "never
 *    interviewed". This module only READS that section (tolerantly — the
 *    channel must never hard-fail on a config the aiui CLI would reject);
 *    writes go through the aiui CLI's schema-validated config machinery.
 *  - **resolution** is mode-dependent: a SOURCE checkout (dev) honors the
 *    environment first — `.env`/direnv keep working — then the vault; an
 *    INSTALLED aiui ignores the environment entirely (a stray env var must
 *    not silently override the vault, and vault-side resolution keeps keys
 *    out of the agent's environment altogether).
 *
 * The Anthropic key stays out of scope — it belongs to the `claude` CLI, not
 * the channel (the same carve-out as the ephemeral-keys exploration).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./index";
import { packageFromSource } from "./provenance";
import { vaultLookup } from "./vault";

/**
 * Env var that forces INSTALLED key resolution (env ignored, OS vault only) in
 * every process that honors it — the `aiui claude` launcher and the spawned
 * channel alike, since a child inherits it. Set it (to any value but empty /
 * `0` / `false`) to exercise the installed-user startup flow from a source
 * checkout. It only steers key resolution — nothing else about source-vs-dist.
 */
export const FORCE_INSTALLED_ENV = "AIUI_NO_SOURCE_MODE";

/**
 * The key-resolution mode for a package: `source` when running from the
 * monorepo checkout (the environment/.env is honored), otherwise `installed`
 * (OS vault only). {@link FORCE_INSTALLED_ENV} overrides both to `installed`.
 * The one place every caller — launcher and channel — decides this, so the
 * env override reaches all of them.
 */
export function vendorKeysMode(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): "source" | "installed" {
  const forced = env[FORCE_INSTALLED_ENV]?.trim().toLowerCase();
  if (forced !== undefined && forced !== "" && forced !== "0" && forced !== "false") {
    return "installed";
  }
  return packageFromSource(packageName) ? "source" : "installed";
}

/** One vendor the channel can hold a key for. */
export interface VendorKeySpec {
  /** The config-facing provider id (`keys.<provider>` in config.json). */
  provider: VendorProvider;
  /** The env var name — also the vault account, e.g. `OPENAI_API_KEY`. */
  envVar: string;
  /** Human label for prompts and status displays. */
  label: string;
  /** What the key powers, for the interview's one-line context. */
  purpose: string;
}

export type VendorProvider = "openai" | "gemini" | "elevenlabs";

/** The channel's three vendors. */
export const VENDOR_KEYS: readonly VendorKeySpec[] = [
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    purpose: "speech transcription, dictation correction, and the default linter/oracle",
  },
  {
    provider: "gemini",
    envVar: "GEMINI_API_KEY",
    label: "Gemini",
    purpose: "the Gemini Live realtime engine and the Gemini linter/oracle options",
  },
  {
    provider: "elevenlabs",
    envVar: "ELEVEN_LABS_API_KEY",
    label: "ElevenLabs",
    purpose: "Scribe v2 speech transcription (the default transcriber)",
  },
] as const;

export function vendorKeySpec(provider: VendorProvider): VendorKeySpec {
  const spec = VENDOR_KEYS.find((k) => k.provider === provider);
  if (spec === undefined) {
    throw new Error(`unknown vendor provider "${provider}"`);
  }
  return spec;
}

/** The user's recorded choice for a provider; absence = never interviewed. */
export type KeyDecision = "vault" | "skip";
export type KeyDecisions = Partial<Record<VendorProvider, KeyDecision>>;

/**
 * Read the `keys` section of the user config, TOLERANTLY: a missing file, a
 * malformed file, or junk values yield `{}` / drop the bad entry rather than
 * throwing. The aiui CLI's own loader is the strict one (it hard-fails on a
 * malformed config, deliberately); this reader exists for the CHANNEL, which
 * must boot into its keyless degradation posture rather than die because a
 * config file it doesn't own has a typo.
 */
export function readKeyDecisions(file?: string): KeyDecisions {
  const path = file ?? join(cacheDir(undefined, { create: false }), "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (typeof keys !== "object" || keys === null) {
    return {};
  }
  const decisions: KeyDecisions = {};
  for (const { provider } of VENDOR_KEYS) {
    const value = (keys as Record<string, unknown>)[provider];
    if (value === "vault" || value === "skip") {
      decisions[provider] = value;
    }
  }
  return decisions;
}

/** Where a resolved key's value came from — or why there is no value. */
export type KeySource = "env" | "vault" | "skip" | "missing";

export interface ResolvedVendorKey {
  provider: VendorProvider;
  envVar: string;
  label: string;
  source: KeySource;
  /** Present only for `env` / `vault`. Never log this. */
  value?: string;
}

export type ResolvedVendorKeys = Record<VendorProvider, ResolvedVendorKey>;

export interface ResolveVendorKeysOptions {
  /**
   * `"source"` = running from this monorepo checkout (aiui-util's
   * `packageFromSource` on the caller's own package is the usual signal):
   * env vars are honored and WIN. `"installed"`: the environment is ignored
   * for keys — the vault (as gated by the decisions) is the only source.
   */
  mode: "source" | "installed";
  env?: NodeJS.ProcessEnv;
  /** Defaults to {@link readKeyDecisions} of the user config. */
  decisions?: KeyDecisions;
  /** Injectable vault read (defaults to {@link vaultLookup}). */
  lookup?: (account: string) => Promise<string | null>;
  /**
   * Per-lookup guard: a wedged vault (Linux with no D-Bus session, a locked
   * keychain waiting on a prompt that can't render) must degrade the key to
   * `missing`, never hang the caller's boot. Default 3000 ms.
   */
  timeoutMs?: number;
  /** Vault failures/timeouts surface here (once per key), never as throws. */
  onWarn?: (message: string) => void;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 3000;

/**
 * Resolve all three vendor keys, non-interactively and without ever throwing:
 *
 *   source mode:    env → vault (unless skipped) → missing
 *   installed mode:       vault (unless skipped) → missing
 *
 * A `skip` decision beats the vault but NOT the env in source mode — a dev
 * who exports a key has said so more recently and more directly than an old
 * interview answer. `missing` covers both "decided vault but the entry is
 * gone" and "never interviewed"; interactive callers (the launch gap-fill)
 * distinguish those via the decisions, not this result.
 */
export async function resolveVendorKeys(
  options: ResolveVendorKeysOptions,
): Promise<ResolvedVendorKeys> {
  const env = options.env ?? process.env;
  const decisions = options.decisions ?? readKeyDecisions();
  const lookup = options.lookup ?? ((account: string) => vaultLookup(account));
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;

  const resolved = {} as ResolvedVendorKeys;
  for (const spec of VENDOR_KEYS) {
    resolved[spec.provider] = await resolveOne(spec, {
      mode: options.mode,
      env,
      decision: decisions[spec.provider],
      lookup,
      timeoutMs,
      onWarn: options.onWarn,
    });
  }
  return resolved;
}

async function resolveOne(
  spec: VendorKeySpec,
  opts: {
    mode: "source" | "installed";
    env: NodeJS.ProcessEnv;
    decision: KeyDecision | undefined;
    lookup: (account: string) => Promise<string | null>;
    timeoutMs: number;
    onWarn?: (message: string) => void;
  },
): Promise<ResolvedVendorKey> {
  const base = { provider: spec.provider, envVar: spec.envVar, label: spec.label };
  if (opts.mode === "source") {
    const fromEnv = opts.env[spec.envVar]?.trim();
    if (fromEnv) {
      return { ...base, source: "env", value: fromEnv };
    }
  }
  if (opts.decision === "skip") {
    return { ...base, source: "skip" };
  }
  const value = await guardedLookup(spec, opts);
  if (value !== null && value !== "") {
    return { ...base, source: "vault", value };
  }
  return { ...base, source: "missing" };
}

/** A vault read that can only ever produce a value or null — errors and
 * timeouts warn once and degrade to null (→ `missing`). */
async function guardedLookup(
  spec: VendorKeySpec,
  opts: {
    lookup: (account: string) => Promise<string | null>;
    timeoutMs: number;
    onWarn?: (message: string) => void;
  },
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("timeout"), opts.timeoutMs);
  });
  try {
    const raced = await Promise.race([opts.lookup(spec.envVar), timeout]);
    if (raced === "timeout") {
      opts.onWarn?.(
        `OS vault lookup for ${spec.envVar} timed out after ${opts.timeoutMs}ms — ` +
          "treating the key as absent (a locked keyring or missing D-Bus session can cause this)",
      );
      return null;
    }
    return raced;
  } catch (err) {
    opts.onWarn?.(
      `OS vault lookup for ${spec.envVar} failed — treating the key as absent: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
