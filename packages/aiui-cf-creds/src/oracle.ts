/**
 * oracle.ts — the federated KeySource: `ek_` client secrets minted entirely
 * browser-side, with NO parent key existing anywhere.
 *
 * The chain (verified live against a deployed broker, 2026-08-07): the
 * broker's ephemeral AWS credentials → STS `GetWebIdentityToken` (a ≤300 s
 * OIDC JWT) → the OpenAI SDK's `workloadIdentity` exchange (internal,
 * auto-refreshed) → `POST /v1/realtime/client_secrets` → `ek_`. Every link
 * before the mint is the kit's (`cf-creds-openai`); this module owns only the
 * mint call and the mapping onto the oracle's {@link KeySource} contract.
 *
 * This is the fourth species in the oracle's key chain — compose it as
 * `cachingKeySource(federatedKeySource({...}))` behind paste-key and dev-key:
 * caching is CORRECT here for the same reason it is over `mintingKeySource`
 * (one `ek_` opens multiple sessions until it expires).
 */
import type { KeySource, OracleCredential } from "@habemus-papadum/aiui-oracle";
import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import { createFederatedOpenAI } from "@habemus-papadum/cf-creds-openai";
import { type BrokerOptions, brokerAwsManager } from "./shared";

/**
 * The one SDK surface the mint uses — structural, so tests inject a stub and
 * this package never names the `openai` types in its own signatures (the SDK
 * stays `cf-creds-openai`'s peer, reached only through
 * `createFederatedOpenAI`).
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
  /** Reuse the app's manager; default constructs one against `brokerUrl`. */
  manager?: CredentialManager<AwsCredentials>;
  /** STS region — `GetWebIdentityToken` exists only on regional endpoints. */
  region: string;
  /** From the OpenAI dashboard's provider registration (`idp_…`). Baked at
   * the composition root: per-deployment, non-secret, required (D3). */
  identityProviderId: string;
  /** From the OpenAI service account (`user-…`) — created KEYLESS; federation
   * is the sole way in. */
  serviceAccountId: string;
  /** `ek_` TTL, seconds; vendor bounds 10–7200. Default 600. */
  expiresAfterSeconds?: number;
  /** Must match the audience configured on the identity provider (the kit
   * defaults to the vendor API root). */
  audience?: string;
  /** Inject a ready client (tests, a custom federation). Default:
   * `createFederatedOpenAI` over the resolved manager. */
  client?: MintClient;
}

/**
 * Mint `ek_` client secrets browser-side over workload identity federation.
 * The wire session config is forwarded as the secret's baked DEFAULT, not a
 * sandbox — the client can `session.update` over it; TTL is the real bound.
 */
export function federatedKeySource(options: FederatedMintOptions): KeySource {
  // Lazy: a chained source that never wins must not build SDK clients.
  let client: MintClient | undefined;
  const clientOf = (): MintClient => {
    client ??=
      options.client ??
      createFederatedOpenAI({
        manager: options.manager ?? brokerAwsManager(options),
        region: options.region,
        identityProviderId: options.identityProviderId,
        serviceAccountId: options.serviceAccountId,
        ...(options.audience === undefined ? {} : { audience: options.audience }),
      });
    return client;
  };
  return {
    describe: () => "cf-federation",
    async credential(session): Promise<OracleCredential> {
      const minted = await clientOf().realtime.clientSecrets.create({
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
