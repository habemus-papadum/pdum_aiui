/**
 * The channel's resolved vendor keys — boot-time truth, one stash.
 *
 * The commands (`mcp`, `serve`) resolve the three vendor keys ONCE at boot
 * through aiui-util's `resolveVendorKeys` (source mode: env → OS vault;
 * installed: OS vault only, the environment deliberately ignored — see
 * vendor-keys.ts there) and park the result here. `intent-v1` reads keys
 * through {@link vendorKey} instead of `process.env`, which is what keeps an
 * installed channel's keys out of the agent's environment entirely: they
 * travel OS vault → this process, never through `claude`'s env where a shell
 * `env` would print them.
 *
 * With NO stash set — unit tests, embedders that build their own format —
 * {@link vendorKey} falls back to `process.env`, preserving the historical
 * contract. The stash lives on `globalThis` under a `Symbol.for` key so the
 * dev hot-reload path (reloadable.ts re-imports intent-v1 as a fresh module)
 * cannot lose it with the module instance.
 */

import {
  type KeySource,
  type ResolvedVendorKeys,
  resolveVendorKeys,
  vendorKeysMode,
} from "@habemus-papadum/aiui-util";

const STASH_KEY = Symbol.for("aiui.channel.vendorKeys");

interface StashEntry {
  source: KeySource;
  value?: string;
}

type Stash = Record<string, StashEntry>;

function currentStash(): Stash | undefined {
  return (globalThis as Record<symbol, unknown>)[STASH_KEY] as Stash | undefined;
}

/** Park the boot-time resolution (called once by the mcp/serve commands). */
export function setResolvedVendorKeys(resolved: ResolvedVendorKeys): void {
  const stash: Stash = {};
  for (const key of Object.values(resolved)) {
    stash[key.envVar] = {
      source: key.source,
      ...(key.value !== undefined ? { value: key.value } : {}),
    };
  }
  (globalThis as Record<symbol, unknown>)[STASH_KEY] = stash;
}

/**
 * The resolved value for an env-var-named vendor key. Stash set → its value
 * (undefined for skip/missing — even if the env var IS set, which is the
 * installed-mode env-ignoring contract). No stash → `process.env`, the
 * historical behavior tests and embedders rely on.
 */
export function vendorKey(envVar: string): string | undefined {
  const stash = currentStash();
  if (stash === undefined) {
    return process.env[envVar];
  }
  return stash[envVar]?.value;
}

/** True when the user DECIDED not to use this provider (`aiui keys`) — a
 * chosen absence, phrased calmly by the degradation notes, vs a missing key
 * phrased as something to fix. */
export function vendorKeySkipped(envVar: string): boolean {
  return currentStash()?.[envVar]?.source === "skip";
}

/** How a degradation note names an absent key: chosen vs missing. */
export function absentKeyPhrase(envVar: string): string {
  return vendorKeySkipped(envVar)
    ? `${envVar} skipped by choice — \`aiui keys\` to revisit`
    : `no ${envVar}`;
}

/**
 * The boot-time resolution both commands run: decide the mode from this
 * package's own provenance (a source checkout honors the environment —
 * `.env`/direnv keep working; an installed channel reads the OS vault only),
 * resolve all three keys without ever throwing or hanging (vault errors and
 * timeouts degrade to `missing`, surfaced through `log`), and park the result
 * for {@link vendorKey}. The one-line source summary is deliberate log
 * hygiene: sources only, never values.
 */
export async function resolveAndStashVendorKeys(log: (message: string) => void): Promise<void> {
  const mode = vendorKeysMode("@habemus-papadum/aiui-claude-channel");
  const resolved = await resolveVendorKeys({ mode, onWarn: log });
  setResolvedVendorKeys(resolved);
  const summary = Object.values(resolved)
    .map((key) => `${key.provider}=${key.source}`)
    .join(" · ");
  log(`vendor keys (${mode} mode): ${summary}`);
}
