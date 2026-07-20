/**
 * Shared types + constants for the OS-vault exploration.
 *
 * Scope: the channel's three vendor API keys (the Anthropic key belongs to the
 * `claude` CLI, not the channel, so it's out of scope — same carve-out as the
 * sibling `exploration/ephemeral-keys` spike). This spike is otherwise
 * INDEPENDENT of that one: it stores/resolves the long-lived PARENT keys
 * themselves, not short-lived derived credentials.
 */

/** The channel's three vendor API keys, by their env var name. */
export const VENDOR_KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "ELEVEN_LABS_API_KEY"] as const;

export type VendorKeyName = (typeof VENDOR_KEYS)[number];

export function isVendorKeyName(s: string): s is VendorKeyName {
  return (VENDOR_KEYS as readonly string[]).includes(s);
}

/**
 * Default vault "service" (macOS keychain `-s`) / attribute value (Linux
 * `secret-tool` `service` attribute) that namespaces every entry this tool
 * writes. The "account" (macOS `-a`) / `account` attribute is always the env
 * var name itself, e.g. service=`aiui-keys`, account=`OPENAI_API_KEY` — so a
 * human browsing Keychain Access or `seahorse` sees exactly which key is
 * which, and cleanup is a matter of matching on the service name.
 *
 * Overridable per-invocation with `--service <name>`, which is how the live
 * verification in this spike used `aiui-keys-test` instead of the real
 * `aiui-keys` — never hand-edit this constant to "temporarily" test, always
 * pass the flag, so nothing here silently drifts.
 */
export const DEFAULT_VAULT_SERVICE = "aiui-keys";

/**
 * A small, platform-agnostic interface every backend implements. Only three
 * verbs, matching exactly what the resolver and the store/delete commands
 * need — deliberately not a general-purpose secrets API.
 */
export interface VaultBackend {
  /** `process.platform` value this backend targets (for error messages/logs). */
  readonly platform: string;
  /** Human label for logs, e.g. "macOS Keychain (security)". */
  readonly label: string;
  /** Create or overwrite the secret for (service, account). */
  store(service: string, account: string, secret: string): Promise<void>;
  /** Return the secret, or `null` if no matching entry exists. */
  lookup(service: string, account: string): Promise<string | null>;
  /** Remove the entry. Returns `false` (not an error) if nothing matched. */
  delete(service: string, account: string): Promise<boolean>;
}

/** Where a resolved key's value came from. */
export type ResolvedFrom = "env" | "vault";

export interface ResolvedKey {
  name: string;
  from: ResolvedFrom;
  value: string;
}

/** Thrown by `resolveKey` when a key is in neither the environment nor the vault. */
export class KeyNotFoundError extends Error {
  constructor(
    public readonly name: string,
    public readonly service: string,
  ) {
    super(
      `${name} is not set in the environment and has no entry in the OS vault ` +
        `(service "${service}", account "${name}"). Store it with: ` +
        `npm run store -- ${name}`,
    );
    this.name = "KeyNotFoundError";
  }
}
