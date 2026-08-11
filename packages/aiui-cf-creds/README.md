# @habemus-papadum/aiui-cf-creds

Broker-backed ephemeral credentials for aiui apps: adapters from the
[`cf_browser_credentials`](https://github.com/habemus-papadum/cf_browser_credentials) kit
(`@habemus-papadum/cf-*`) to aiui's existing credential seams. A bridge in the strict sense — it
implements one contract against the other and adds no seam of its own. Contract of record: the
aiui-cf-creds proposal (pdum_aiui git history).

The target apps are **serverless/static aiui deployments** behind a broker-fronted origin (a small
Cloudflare Worker owning `/api/credentials/*`, static site and broker both behind Cloudflare
Access): a static page that mints its own short-lived credentials with **no vendor key existing
anywhere** — not in the page, not in a server, not at all.

## Install

```sh
npm install @habemus-papadum/aiui-cf-creds
```

## The subpaths

Each bridge lives on its own subpath so an app pays only for what it uses:

### `aiui-cf-creds/oracle` — the federated KeySource

`ek_` client secrets minted entirely browser-side over AWS workload identity federation
(broker credentials → STS `GetWebIdentityToken` → the OpenAI SDK's `workloadIdentity`
exchange → `POST /v1/realtime/client_secrets`). No parent key exists; the OpenAI service
account behind it is created keyless.

```ts
import { chainKeySource, cachingKeySource, pasteKeySource, devKeySource } from "@habemus-papadum/aiui-oracle";
import { federatedKeySource } from "@habemus-papadum/aiui-cf-creds/oracle";

const keySource = chainKeySource([
  pasteKeySource(localStorage, {}),   // a pasted key still trumps everything
  devKeySource("openai", {}),         // dev serve still just works
  cachingKeySource(                   // one ek_ opens multiple sessions until TTL
    federatedKeySource({ region, identityProviderId, serviceAccountId }),
  ),
]);
```

The federation facts (`region`, `identityProviderId`, `serviceAccountId`) are per-deployment,
non-secret, and baked at the app's composition root — this package carries no deployment identity.

### `aiui-cf-creds/stt` — both STT credential flavors

**The default engine is ElevenLabs Scribe** (the stack-wide decision — richest word
data); the OpenAI transcription flavor is the alternate.

```ts
import { scribeConnectUrl, transcriptionKeySource } from "@habemus-papadum/aiui-cf-creds/stt";

// THE DEFAULT — ElevenLabs scribe: SINGLE-USE. One call = one connect;
// there is no cache to hold wrong.
const socket = new WebSocket(await scribeConnectUrl());

// The ALTERNATE — OpenAI transcription-type sessions: an ordinary ek_
// KeySource whose minted secrets carry the transcription session config.
const source = transcriptionKeySource({ region, identityProviderId, serviceAccountId });
```

### `aiui-cf-creds/mosaic` — the credential-installing connector

Wrap the base connector the app already constructs; every query (including SQL Mosaic
generates itself for brushes and linked selections) first ensures current broker AWS
credentials are installed in DuckDB. `MosaicView` never learns credentials exist.

```ts
import { brokerConnector } from "@habemus-papadum/aiui-cf-creds/mosaic";

coordinator.databaseConnector(
  brokerConnector(wasmConnector({ duckdb: db, connection }), { region: "us-east-1" }),
);
```

## One deployment knob

In production everything is same-origin relative (the kit's `/api/credentials/*` convention) —
zero config. For cross-origin dev (`vite dev` against the deployed broker, authenticated by the
same Access cookie), pass the broker's origin once:

```ts
import { brokerAwsManager } from "@habemus-papadum/aiui-cf-creds";

const manager = brokerAwsManager({ brokerUrl: "https://app.example.com" });
// …then hand the one manager to each bridge's `manager` option.
```
