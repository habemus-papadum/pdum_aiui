/**
 * keys.ts — the KeySource implementations. Every transport connects with an
 * EPHEMERAL client secret (`ek_…`); sources differ only in how one is obtained:
 *
 *  - a pasted `ek_` is used directly;
 *  - a pasted parent key (`sk-…`) mints one IN THE BROWSER — CORS on
 *    `/v1/realtime/client_secrets` is open (measured 2026-07-26), so this is a
 *    key-custody choice, not a mechanics one: paste-key mode is the user
 *    knowingly holding their own key in their own browser (standalone/dev);
 *  - a mint URL exchanges an app identity for an `ek_` server-side (static
 *    sites; the channel later).
 *
 * Ground truth (exploration/ephemeral-keys, live 2026-07-20): the mint is
 * `POST /v1/realtime/client_secrets`, TTL 10–7200 s; an expired `ek_` can fail
 * EITHER at upgrade (401) or after open (an `error` event) — callers handle
 * both.
 *
 * REVISED 2026-08-25 (found live, prod): ephemeral secrets are now
 * SINGLE-USE — a second `/v1/realtime/calls` with the same `ek_` is refused
 * `401 ephemeral_token_already_used`. "One secret opens multiple sessions
 * until it expires" (measured 2026-07-20) no longer holds; mint fresh per
 * connect, and do NOT wrap an ek_-minting source in {@link cachingKeySource}.
 */

import type { KeySource, OracleCredential } from "./types";

export const OPENAI_BASE_URL = "https://api.openai.com";

/** The localStorage slot the paste-key source and its widget share. */
export const PASTED_KEY_STORAGE_KEY = "aiui.oracle.key";

export interface MintOptions {
  ttlSeconds?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Mint an ephemeral client secret from a parent key. Exposed for the lab's
 * "test the ephemeral flow" mode as much as for the sources below. */
export async function mintClientSecret(
  parentKey: string,
  session: Record<string, unknown>,
  options: MintOptions = {},
): Promise<OracleCredential> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(
    `${options.baseUrl ?? OPENAI_BASE_URL}/v1/realtime/client_secrets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parentKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: options.ttlSeconds ?? 600 },
        session,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`client_secrets mint failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as { value?: string; expires_at?: number };
  if (typeof data.value !== "string" || data.value === "") {
    throw new Error("client_secrets mint returned no value");
  }
  return { ek: data.value, expiresAt: typeof data.expires_at === "number" ? data.expires_at : 0 };
}

/** A fixed key: `ek_` passes through, anything else mints. */
export function staticKeySource(key: string, options: MintOptions = {}): KeySource {
  return {
    describe: () => (key.startsWith("ek_") ? "static:ephemeral" : "static:mint-from-parent"),
    async credential(session) {
      if (key.startsWith("ek_")) {
        return { ek: key, expiresAt: 0 };
      }
      return mintClientSecret(key, session, options);
    },
  };
}

/**
 * The user's own key, from localStorage (the `OracleKey` widget writes the
 * same slot — and the slot is ORIGIN-wide, so in a composed document one
 * paste covers every app). Read at connect time, so pasting a new key needs
 * no reload. In the standard chain this TRUMPS everything.
 */
export function pasteKeySource(
  storage: Pick<Storage, "getItem"> = localStorage,
  options: MintOptions = {},
): KeySource {
  return {
    describe: () => "paste-key",
    async credential(session) {
      const key = storage.getItem(PASTED_KEY_STORAGE_KEY)?.trim();
      if (key === undefined || key === "") {
        throw new Error("no key pasted — set one in the oracle's key field");
      }
      return { ...(await staticKeySource(key, options).credential(session)), source: "paste-key" };
    },
  };
}

/**
 * The DEV-MODE key: what the aiui Vite plugin's opt-in `devKeys` option
 * injected at `window.__AIUI__.devKeys` (resolution is the house vendor-key
 * machinery — env first in a source checkout, the OS vault otherwise). Exists
 * only under `vite serve` — a built app never carries it — so a purely static
 * app develops with zero setup (no pasting, no mint server) and deploys on
 * paste-key alone.
 */
export function devKeySource(vendor = "openai", options: MintOptions = {}): KeySource {
  return {
    describe: () => `dev-key:${vendor}`,
    async credential(session) {
      const aiui = (globalThis as Record<string, unknown>).__AIUI__ as
        | { devKeys?: Record<string, string> }
        | undefined;
      const key = aiui?.devKeys?.[vendor];
      if (typeof key !== "string" || key === "") {
        throw new Error(
          `no ${vendor} dev key injected (the aiui vite plugin's devKeys option, dev serve only)`,
        );
      }
      return {
        ...(await staticKeySource(key, options).credential(session)),
        source: `dev-key:${vendor}`,
      };
    },
  };
}

export interface StandardKeySourcesOptions {
  /** A mint endpoint, when this app has one (a channel, a cloud function).
   * Absent = the flow simply doesn't exist for this app. */
  mintUrl?: string;
  storage?: Pick<Storage, "getItem">;
  mint?: MintOptions;
}

/**
 * The canonical V1 chain — the three key flows, in the decided order:
 *
 *  1. the user's PASTED key (trumps everything);
 *  2. the DEV key the Vite plugin injected (dev serve only — a static app
 *     under development just works, no server, nothing pasted);
 *  3. a MINT endpoint, when the app has one (cached, TTL-refreshed).
 *
 * Compose the pieces yourself for a different order (the lab does, to force
 * its mint flow ahead of the dev key).
 */
export function standardKeySources(options: StandardKeySourcesOptions = {}): KeySource {
  const sources: KeySource[] = [
    pasteKeySource(options.storage ?? localStorage, options.mint ?? {}),
    devKeySource("openai", options.mint ?? {}),
  ];
  if (options.mintUrl !== undefined) {
    // No cachingKeySource here anymore: ephemeral secrets are single-use
    // (2026-08-25) — a cached ek_ fails every reconnect.
    sources.push(
      mintingKeySource(
        options.mintUrl,
        options.mint?.fetchImpl !== undefined ? { fetchImpl: options.mint.fetchImpl } : {},
      ),
    );
  }
  return chainKeySource(sources);
}

/**
 * Try sources IN ORDER; the first to produce a credential wins, a source
 * that throws falls through to the next. The V1 priority chain is
 * `chainKeySource([pasteKeySource(), cachingKeySource(mintingKeySource(…))])`
 * — a user's pasted key TRUMPS everything (owner decision); the dev-server
 * mint is the fallback; all failing, the combined refusals surface loudly.
 */
export function chainKeySource(sources: KeySource[]): KeySource {
  return {
    describe: () => `chain(${sources.map((source) => source.describe()).join(" → ")})`,
    async credential(session) {
      const refusals: string[] = [];
      for (const source of sources) {
        try {
          return await source.credential(session);
        } catch (error) {
          refusals.push(
            `${source.describe()}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw new Error(`no key source produced a credential — ${refusals.join("; ")}`);
    },
  };
}

/**
 * Cache the inner source's credential and refresh it only when its TTL is
 * within `marginSeconds` of expiring. NOT for `ek_`-minting sources anymore:
 * ephemeral secrets became single-use (2026-08-25, the header's revision) —
 * a cached one fails every reconnect with `ephemeral_token_already_used`.
 * Kept for credentials that genuinely remain valid across uses. Credentials
 * with an unknown expiry (a pasted `ek_`) are never cached — the inner
 * source is the truth.
 */
export function cachingKeySource(inner: KeySource, marginSeconds = 60): KeySource {
  let held: OracleCredential | undefined;
  return {
    describe: () => `${inner.describe()} (cached)`,
    async credential(session) {
      const now = Date.now() / 1000;
      if (held !== undefined && held.expiresAt > 0 && held.expiresAt - marginSeconds > now) {
        return held;
      }
      held = await inner.credential(session);
      return held;
    },
  };
}

/**
 * A mint service: POST the wire session config to a URL we trust (the lab's
 * dev-server mount, the standalone mint server, a channel route later); it
 * answers `{ value, expires_at }` — the same shape the vendor mint returns.
 */
export function mintingKeySource(
  mintUrl: string,
  options: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): KeySource {
  return {
    describe: () => `mint:${mintUrl}`,
    async credential(session) {
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(mintUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify({ session }),
      });
      if (!response.ok) {
        throw new Error(`mint service failed (${response.status})`);
      }
      const data = (await response.json()) as { value?: string; expires_at?: number };
      if (typeof data.value !== "string" || data.value === "") {
        throw new Error("mint service returned no value");
      }
      return {
        ek: data.value,
        expiresAt: typeof data.expires_at === "number" ? data.expires_at : 0,
        source: `mint:${mintUrl}`,
      };
    },
  };
}
