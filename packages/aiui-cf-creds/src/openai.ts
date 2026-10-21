/**
 * OpenAI Realtime credentials through workload identity federation.
 * The credential service returns an identity token and federation IDs for a
 * grant path. The SDK exchanges the identity token, then requests an `ek_`
 * client secret. OpenAIKeySource matches aiui-oracle's structural contract
 * without depending on that internal package.
 */
import { createBrokeredOpenAI, OPENAI_CREDENTIALS_PATH } from "@habemus-papadum/cf-creds-openai";
import { type BrokerOptions, brokerRoute } from "./shared";

/**
 * A short-lived credential for opening realtime sessions. One `ek_` opens
 * multiple sessions until it expires — reconnects reuse it within TTL. The
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
 * The OpenAI SDK interface used to request client secrets. Tests inject a stub;
 * this package never names the `openai` types in its own signatures (the SDK
 * stays `cf-creds-openai`'s peer, reached only through
 * `createBrokeredOpenAI`).
 */
export interface RealtimeClient {
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

export interface FederatedCredentialOptions extends BrokerOptions {
  /** `ek_` TTL, seconds; vendor bounds 10–7200. Default 600. */
  expiresAfterSeconds?: number;
  /** Inject a ready client (tests, a custom federation). Default: the
   * credential-service response (`createBrokeredOpenAI`); `grantPath` is then required. */
  client?: RealtimeClient;
}

/**
 * Request `ek_` client secrets browser-side over workload identity federation.
 * The wire session config is forwarded as the secret's baked DEFAULT, not a
 * sandbox — the client can `session.update` over it; TTL is the real bound.
 */
export function federatedKeySource(options: FederatedCredentialOptions): OpenAIKeySource {
  // Create the SDK client only when credentials are requested. Concurrent
  // calls share the promise; a failed request can be retried.
  let clientPromise: Promise<RealtimeClient> | undefined;
  const buildClient = async (): Promise<RealtimeClient> => {
    if (options.client !== undefined) return options.client;
    if (options.grantPath === undefined) {
      throw new Error("federatedKeySource needs `grantPath`");
    }
    // One request returns the identity token and federation configuration.
    const { client } = await createBrokeredOpenAI({
      url: brokerRoute(OPENAI_CREDENTIALS_PATH, options.brokerUrl, options.grantPath),
    });
    return client;
  };
  const clientOf = (): Promise<RealtimeClient> => {
    clientPromise ??= buildClient().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
    return clientPromise;
  };
  return {
    describe: () => "cf-federation",
    async credential(session): Promise<OpenAICredential> {
      const credential = await (await clientOf()).realtime.clientSecrets.create({
        expires_after: {
          anchor: "created_at",
          seconds: options.expiresAfterSeconds ?? 600,
        },
        session,
      });
      if (typeof credential.value !== "string" || credential.value === "") {
        throw new Error("OpenAI returned no client secret");
      }
      return {
        ek: credential.value,
        expiresAt: typeof credential.expires_at === "number" ? credential.expires_at : 0,
        source: "cf-federation",
      };
    },
  };
}
