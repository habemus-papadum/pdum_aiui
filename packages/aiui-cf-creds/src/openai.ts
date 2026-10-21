/**
 * openai.ts — the federated OpenAI key source: `ek_` client secrets minted
 * entirely browser-side, with NO parent key existing anywhere.
 *
 * The chain (kit ≥0.6): one keyed broker mint returns a short-lived identity
 * token the broker itself signed, plus the audience and federation ids → the
 * OpenAI SDK's `workloadIdentity` exchange (internal, re-minting on demand) →
 * `POST /v1/realtime/client_secrets` → `ek_`. No AWS leg remains. Every link
 * before the mint is the kit's (`cf-creds-openai`); this module owns only the
 * mint call and the mapping onto the key-source contract below.
 *
 * The app passes only `key` — its own name — and everything else rides the
 * broker's one-mint bundle (`createBrokeredOpenAI`). The explicit id trio of
 * kit ≤0.5 went with the STS leg.
 *
 * The contract is declared HERE, structurally: {@link OpenAIKeySource} and
 * {@link OpenAICredential} are the shapes of aiui-oracle's `KeySource` and
 * `OracleCredential`, so the oracle accepts a federated source as the fourth
 * species in its key chain — composed as
 * `cachingKeySource(federatedKeySource({...}))` behind paste-key and dev-key
 * (caching is CORRECT here, as over `mintingKeySource`: one `ek_` opens
 * multiple sessions until it expires) — while this public package depends on
 * nothing of the oracle, which is internal scaffolding. The two declarations
 * are pinned equal at compile time in demos/audio, the one package with both.
 */
import { createBrokeredOpenAI, OPENAI_CREDENTIALS_PATH } from "@habemus-papadum/cf-creds-openai";
import { type BrokerOptions, brokerRoute } from "./shared";

/**
 * A short-lived credential for opening realtime sessions. One `ek_` mints
 * MULTIPLE sessions until it expires — reconnects reuse it within TTL. The
 * shape of aiui-oracle's `OracleCredential`.
 */
export interface OpenAICredential {
  ek: string;
  /** Unix seconds; 0 = unknown. */
  expiresAt: number;
  /** Which source answered (paste-key / dev-key / cf-federation) — the
   * ledger's auth attribution. */
  source?: string;
}

/** Where realtime credentials come from — the shape of aiui-oracle's `KeySource`. */
export interface OpenAIKeySource {
  /** Human-readable, for the ledger ("paste-key", "cf-federation"). */
  describe(): string;
  /**
   * Produce a session-opening credential for the given wire session config.
   * (The baked config is a DEFAULT, not a sandbox — the client can
   * `session.update` over it; TTL is the real bound.)
   */
  credential(session: Record<string, unknown>): Promise<OpenAICredential>;
}

/**
 * The one SDK surface the mint uses — structural, so tests inject a stub and
 * this package never names the `openai` types in its own signatures (the SDK
 * stays `cf-creds-openai`'s peer, reached only through
 * `createBrokeredOpenAI`).
 */
export interface MintClient {
  realtime: {
    clientSecrets: {
      // Loose on purpose: the fields the SDK's ClientSecretCreateParams
      // declares optional must be optional here too, or the real client
      // stops being assignable (methods are compared bivariantly, but BOTH
      // directions fail when this side is stricter than the SDK's).
      create(body: {
        expires_after?: { anchor?: "created_at"; seconds?: number };
        session?: unknown;
      }): Promise<{ value: string; expires_at: number }>;
    };
  };
}

export interface FederatedMintOptions extends BrokerOptions {
  /** `ek_` TTL, seconds; vendor bounds 10–7200. Default 600. */
  expiresAfterSeconds?: number;
  /** Inject a ready client (tests, a custom federation). Default: the
   * keyed broker bundle (`createBrokeredOpenAI`); `key` is then required. */
  client?: MintClient;
}

/**
 * Mint `ek_` client secrets browser-side over workload identity federation.
 * The wire session config is forwarded as the secret's baked DEFAULT, not a
 * sandbox — the client can `session.update` over it; TTL is the real bound.
 */
export function federatedKeySource(options: FederatedMintOptions): OpenAIKeySource {
  // Lazy: a chained source that never wins must not build SDK clients (nor,
  // in the keyed lane, fetch the broker bundle). Memoized as a promise; a
  // failed build is forgotten so a transient broker error doesn't wedge the
  // source for the page's lifetime.
  let clientPromise: Promise<MintClient> | undefined;
  const buildClient = async (): Promise<MintClient> => {
    if (options.client !== undefined) return options.client;
    if (options.key === undefined) {
      throw new Error("federatedKeySource needs `key` (the broker's key contract)");
    }
    // The key contract: one mint returns the identity token AND the whole
    // federation config — no ids at the composition root.
    const { client } = await createBrokeredOpenAI({
      url: brokerRoute(OPENAI_CREDENTIALS_PATH, options.brokerUrl, options.key),
    });
    return client;
  };
  const clientOf = (): Promise<MintClient> => {
    clientPromise ??= buildClient().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
    return clientPromise;
  };
  return {
    describe: () => "cf-federation",
    async credential(session): Promise<OpenAICredential> {
      const minted = await (await clientOf()).realtime.clientSecrets.create({
        expires_after: {
          anchor: "created_at",
          seconds: options.expiresAfterSeconds ?? 600,
        },
        session,
      });
      if (typeof minted.value !== "string" || minted.value === "") {
        throw new Error("federated mint returned no client secret");
      }
      return {
        ek: minted.value,
        expiresAt: typeof minted.expires_at === "number" ? minted.expires_at : 0,
        source: "cf-federation",
      };
    },
  };
}
