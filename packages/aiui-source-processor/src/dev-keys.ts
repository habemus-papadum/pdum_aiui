/**
 * dev-keys.ts — the `devKeys` opt-in's resolver: vendor API keys for a
 * DEV-SERVED page, read from the ENVIRONMENT and nowhere else.
 *
 * Decided 2026-10-10 (owner): a dev key is whatever the process that starts
 * the dev server has in its environment — a `.env` in the checkout picked up
 * by direnv, or a plain `export` in the shell. No vault, no config file, no
 * interview: those belonged to the retired launcher's key machinery
 * (aiui-util's `resolveVendorKeys`; git history), and a Vite plugin that
 * shelled out to an OS keychain was the wrong shape for a build tool anyway.
 *
 * The provider table is the one the launcher kept, so the variable names an
 * app's `.env` already carries keep working. The Anthropic key stays out of
 * scope — it belongs to the `claude` CLI, never to a served page.
 */

/** One vendor a dev-served page can be handed a key for. */
export type VendorProvider = "elevenlabs" | "openai" | "gemini" | "motherduck";

export interface VendorKeySpec {
  /** The option-facing provider id (`devKeys: [<provider>]`). */
  provider: VendorProvider;
  /** The environment variable the key is read from. */
  envVar: string;
  /** Human label for the warning when the variable is absent. */
  label: string;
}

/** The providers `devKeys` knows, and the env var each one reads. */
export const VENDOR_KEYS: readonly VendorKeySpec[] = [
  { provider: "elevenlabs", envVar: "ELEVEN_LABS_API_KEY", label: "ElevenLabs" },
  { provider: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
  { provider: "gemini", envVar: "GEMINI_API_KEY", label: "Gemini" },
  {
    // Deliberately NOT `MOTHERDUCK_TOKEN`: that name is what MotherDuck's own
    // tooling reads and what a data repo's `.env` holds — usually the org
    // admin's read-write token, which must never be seeded into a served
    // page. The browser key is a READ-SCALING token of your own user
    // (read-only; it sees the shares your roles grant).
    provider: "motherduck",
    envVar: "MOTHERDUCK_BROWSER_TOKEN",
    label: "MotherDuck",
  },
] as const;

/** A provider's resolution: its spec plus the value, when the env had one. */
export interface ResolvedDevKey extends VendorKeySpec {
  /** Present when the variable is set and non-blank. Never log this. */
  value?: string;
}

export type ResolvedDevKeys = Record<VendorProvider, ResolvedDevKey>;

/**
 * Read every provider's variable from `env`. Blank or whitespace-only values
 * count as absent. The seed calls this ONCE per dev-server run with the
 * server's own `process.env` — the environment the server started with IS the
 * environment; a page load never re-reads it.
 */
export function resolveDevKeys(env: NodeJS.ProcessEnv = process.env): ResolvedDevKeys {
  const resolved = {} as ResolvedDevKeys;
  for (const spec of VENDOR_KEYS) {
    const value = env[spec.envVar]?.trim();
    resolved[spec.provider] = value ? { ...spec, value } : { ...spec };
  }
  return resolved;
}
