# Getting Started with @habemus-papadum/aiui-cf-creds

Adapters that let aiui components draw their ephemeral credentials from a **credential broker**
built on the `cf_browser_credentials` kit. Four adapters, one per subpath:

| Subpath | What it gives you | Credential type |
| --- | --- | --- |
| `/openai` | `federatedKeySource` — browser-side `ek_` requests, no parent key; the oracle's `KeySource` by shape | federated (request on demand) |
| `/stt` | `scribeConnectUrl` (broker) + `standardScribeConnectUrl` (pasted/dev key or configured broker) | single-use |
| `/mosaic` | `brokerConnector` — queries run with credentials installed | session (cached, rotated) |
| `/motherduck` | `standardMotherDuckEngine` — the in-tab MotherDuck engine (pasted key, dev key, then broker) + `motherDuckRunner` | session (a live session outlives its token; rebuild is explicit) |

## Prerequisites

For the URL-backed helpers, use a credential service that supports `grant_path`, protected by Cloudflare Access,
and — for the federated OpenAI bridge — the one-time OpenAI setup: a keyless service account with
a project role, and a workload identity provider registered for the broker's own OIDC issuer with
a mapping from the `grant_path` claim to that service account.

Applications with their own authentication client can instead inject an OpenAI SDK client,
an AWS source with `get()` and `refresh()`, a MotherDuck token source, or a Scribe connection
callback. Those paths do not require a `grant_path` endpoint. See
[application-owned authentication](../README.md#use-application-owned-authentication) for the
injection points. Pasted-key and development-key helpers remain available for demos.

## The shortest path

```ts
import { federatedKeySource } from "@habemus-papadum/aiui-cf-creds/openai";

const keySource = federatedKeySource({ grantPath: "app" });
```

The service uses the grant path and authenticated identity to select a
credential grant. It returns the identity token and OpenAI federation IDs.
Set `brokerUrl: "https://creds.example.com"` to use a different origin.
The service must accept `grant_path`, and its external OpenAI mapping must
match the JWT claim `grant_path`.

## Credential lifetime and refresh

- **Scribe tokens are single-use** with a fixed 15-minute lifetime before connection. Call
  `scribeConnectUrl()` immediately before *every* WebSocket connect. The API deliberately offers
  nowhere to hold a token.
- **One `ek_` opens multiple sessions** until it expires, so wrapping the federated sources in
  `cachingKeySource` is correct — reconnects inside its TTL reuse the live secret.
- **Mosaic views survive rotation** — they store S3 paths, not credentials; the connector
  re-installs credentials when the broker rotates them.
