# Getting Started with @habemus-papadum/aiui-cf-creds

Adapters that let aiui components draw their ephemeral credentials from a **credential broker**
built on the `cf_browser_credentials` kit. Three bridges, one per subpath:

| Subpath | What it gives you | Credential species |
| --- | --- | --- |
| `/openai` | `federatedKeySource` — browser-side `ek_` minting, no parent key; the oracle's `KeySource` by shape | federated (mint on demand) |
| `/stt` | `scribeConnectUrl` (broker) + `standardScribeConnectUrl` (pasted/dev key or configured broker) | single-use |
| `/mosaic` | `brokerConnector` — queries run with credentials installed | session (cached, rotated) |
| `/motherduck` | `standardMotherDuckEngine` — the in-tab MotherDuck engine (dev key, else the broker) + `motherDuckRunner` | session (a live session outlives its token; rebuild is explicit) |

## Prerequisites

A deployed broker (the kit's worker, ≥0.6) fronting your app's origin behind Cloudflare Access,
and — for the federated OpenAI bridge — the one-time OpenAI setup: a keyless service account with
a project role, and a workload identity provider registered for the broker's own OIDC issuer with
a mapping from the key claim to that service account.

## The shortest path

```ts
import { cachingKeySource } from "@habemus-papadum/aiui-oracle";
import { federatedKeySource } from "@habemus-papadum/aiui-cf-creds/openai";

const keySource = cachingKeySource(
  federatedKeySource({ key: "app" }),  // the app's own name, nothing else
);
```

Under the broker's **key contract** that is the whole composition root: the broker maps
`(key, identity)` to a short-lived identity token it signs plus the audience and OpenAI
federation ids, and returns them with the mint — no deployment identity in the page. For cross-origin dev pass
`brokerUrl: "https://creds.example.com"` (the deployed broker's origin) alongside and log in to
Access in another tab.

## Species rules worth knowing

- **Scribe tokens are single-use** with a fixed 15-minute mint-to-connect TTL. Call
  `scribeConnectUrl()` immediately before *every* WebSocket connect. The API deliberately offers
  nowhere to hold a token.
- **One `ek_` opens multiple sessions** until it expires, so wrapping the federated sources in
  `cachingKeySource` is correct — reconnects inside its TTL reuse the live secret.
- **Mosaic views survive rotation** — they store S3 paths, not credentials; the connector
  re-installs credentials when the broker rotates them.
