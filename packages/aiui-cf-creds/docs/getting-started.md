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
  federatedKeySource({ key: "app" }),  // the app's own name, nothing else
);
```

Under the broker's **key contract** (kit ≥0.4) that is the whole composition root: the broker
maps `(key, identity)` to the role, region, audience, and OpenAI federation ids, and returns
them with the mint — no deployment identity in the page. For cross-origin dev pass
`brokerUrl: "https://creds.example.com"` (the deployed broker's origin) alongside and log in to
Access in another tab.

Against a broker predating the contract, the legacy explicit form still works (deprecated):
`federatedKeySource({ region, identityProviderId, serviceAccountId })` — three per-deployment,
non-secret facts baked at the composition root.

## Species rules worth knowing

- **Scribe tokens are single-use** with a fixed 15-minute mint-to-connect TTL. Call
  `scribeConnectUrl()` immediately before *every* WebSocket connect. The API deliberately offers
  nowhere to hold a token.
- **One `ek_` opens multiple sessions** until it expires, so wrapping the federated sources in
  `cachingKeySource` is correct — reconnects inside its TTL reuse the live secret.
- **Mosaic views survive rotation** — they store S3 paths, not credentials; the connector
  re-installs credentials when the broker rotates them.
