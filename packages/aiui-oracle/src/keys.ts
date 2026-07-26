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
 * both. One secret opens multiple sessions until it expires.
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
 * The standalone/dev default: the key lives in localStorage (the control
 * widget's key prompt writes the same slot). Read at connect time, so pasting
 * a new key needs no reload.
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
      return staticKeySource(key, options).credential(session);
    },
  };
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
 * within `marginSeconds` of expiring — so reconnects inside a session reuse
 * the live `ek_` (one secret opens multiple sessions until it expires) and a
 * long session never trips over a stale one. Credentials with an unknown
 * expiry (a pasted `ek_`) are never cached — the inner source is the truth.
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
      };
    },
  };
}
