# Getting Started with @habemus-papadum/aiui-cf-creds

Adapters that let aiui components draw their ephemeral credentials from a **credential broker**
built on the `cf_browser_credentials` kit. Three bridges, one per subpath:

| Subpath | What it gives you | Credential species |
| --- | --- | --- |
| `/oracle` | `federatedKeySource` — browser-side `ek_` minting, no parent key | federated (mint on demand) |
| `/stt` | `scribeConnectUrl` (ElevenLabs Scribe, **the default engine**) + `transcriptionKeySource` (OpenAI, the alternate) | single-use / federated |
| `/mosaic` | `brokerConnector` — queries run with credentials installed | session (cached, rotated) |

## Prerequisites

A deployed broker (the kit's worker) fronting your app's origin behind Cloudflare Access, and —
for the federated bridges — the one-time infra setup: outbound web identity federation enabled on
the AWS account, `sts:GetWebIdentityToken` allowed on the role, and an OpenAI workload identity
provider + keyless service account pinned to the role ARN.

## The shortest path

```ts
import { cachingKeySource } from "@habemus-papadum/aiui-oracle";
import { federatedKeySource } from "@habemus-papadum/aiui-cf-creds/oracle";

const keySource = cachingKeySource(
  federatedKeySource({
    region: "us-east-1",              // your STS region
    identityProviderId: "idp_…",      // from the OpenAI provider registration
    serviceAccountId: "user-…",       // the keyless service account
  }),
);
```

Those three values are per-deployment, non-secret facts — bake them at the composition root the
same way you already bake asset URLs. In production no other configuration exists; for
cross-origin dev pass `brokerUrl: "https://your-app.example.com"` (the deployed broker's origin)
and log in to Access in another tab.

## Species rules worth knowing

- **Scribe tokens are single-use** with a fixed 15-minute mint-to-connect TTL. Call
  `scribeConnectUrl()` immediately before *every* WebSocket connect. The API deliberately offers
  nowhere to hold a token.
- **One `ek_` opens multiple sessions** until it expires, so wrapping the federated sources in
  `cachingKeySource` is correct — reconnects inside its TTL reuse the live secret.
- **Mosaic views survive rotation** — they store S3 paths, not credentials; the connector
  re-installs credentials when the broker rotates them.
