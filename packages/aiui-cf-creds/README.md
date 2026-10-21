# @habemus-papadum/aiui-cf-creds

Request short-lived credentials for AIUI apps through a Cloudflare Access
credential service. This package adapts the published
[`cf_browser_credentials`](https://github.com/habemus-papadum/cf_browser_credentials)
SDK to OpenAI Realtime, ElevenLabs, Mosaic, and MotherDuck.

## Install

```sh
npm install @habemus-papadum/aiui-cf-creds
```

## The subpaths

Each bridge lives on its own subpath so an app pays only for what it uses:

### `aiui-cf-creds/openai` — the federated OpenAI key source

The service returns a short-lived identity token. The OpenAI SDK exchanges it,
then requests an `ek_` client secret for Realtime sessions. The returned source
implements `OpenAIKeySource`; callers can reuse the secret until it expires.

```ts
import { federatedKeySource } from "@habemus-papadum/aiui-cf-creds/openai";

const source = federatedKeySource({ grantPath: "app" });
const credential = await source.credential({ type: "realtime" });
// Use credential.ek to open the Realtime connection.
```

The app supplies `grantPath`. The response includes the identity token,
audience, and federation IDs. `grantPath` is required unless you supply an
already configured `RealtimeClient`. The credential service must support the
`grant_path` query parameter and return service-issued identity tokens.

### `aiui-cf-creds/stt` — ElevenLabs Scribe credentials

Fresh single-use tokens from a broker or a browser-provided parent key.

```ts
import { scribeConnectUrl, standardScribeConnectUrl } from "@habemus-papadum/aiui-cf-creds/stt";

// Broker-only, one fresh single-use token per connection:
const brokerUrl = () => scribeConnectUrl({ grantPath: "app" });
// Demo keys (pasted/dev), falling back to an explicitly configured broker:
const demoUrl = () => standardScribeConnectUrl({ brokerUrl: "https://creds.example.com", grantPath: "app" });
// Explicit key callback; can read your application's own credential storage:
const customUrl = () => standardScribeConnectUrl({ apiKey: () => myKey });
```

### `aiui-cf-creds/mosaic` — the credential-installing connector

Wrap the base connector the app already constructs; every query (including SQL Mosaic
generates itself for brushes and linked selections) first ensures current broker AWS
credentials are installed in DuckDB. `MosaicView` never learns credentials exist.

```ts
import { brokerConnector } from "@habemus-papadum/aiui-cf-creds/mosaic";
import { duckdbConnector } from "@habemus-papadum/aiui-viz/mosaic-connector";

coordinator.databaseConnector(
  brokerConnector(duckdbConnector({ duckdb: db, connection }), { grantPath: "app" }),
);
```

With `grantPath`, the S3 region rides the broker's credential envelope; without one, pass
`region` explicitly as before.

### `aiui-cf-creds/motherduck` — the in-tab MotherDuck engine

The kit's `motherDuckEngine` composed the way the oracle's key chain is: a DEV key the aiui Vite
plugin injected (`devKeys: ["motherduck"]`, dev serve only, from `MOTHERDUCK_BROWSER_TOKEN`) wins,
else the broker route under the grant path selection. One stock `AsyncDuckDB` with the MotherDuck extension
attached comes back, in the stock types: aiui-viz's `duckdbConnector` (Mosaic's stock connector
plus HUGEINT decoded to numbers — the stock one draws NaN after the first brush) and `duckdbRunner`
take it unchanged; `motherDuckRunner` is the agent's runner over the client's own connection
(`MD_ALL_DATABASES()` under `connection.query()`'s blocking protocol wedges the whole engine; the
client's `send()`-based path answers it — measured; the record is aiui-viz's duckdb-mosaic doc,
shape 4, "The RUN_QUERY wedge").

```ts
import { motherDuckRunner, standardMotherDuckEngine } from "@habemus-papadum/aiui-cf-creds/motherduck";
import { duckdbConnector } from "@habemus-papadum/aiui-viz/mosaic-connector";

const engine = standardMotherDuckEngine({ grantPath: "app", params: { sessionName: "app" } });
const { db, connect, connection } = await engine.ready();
coordinator.databaseConnector(duckdbConnector({ duckdb: db, connection: await connect() }));
registerSqlTools(kit, {
  runner: motherDuckRunner(connection),
  views: [crossfilterViews({ selection: brush, scope })], // optional: the cross-filter's filtered twins
  viewCatalog: "memory",                                   // in the tab's catalog, never the cloud's
  viewEpoch: () => engine.generation,                      // a rebuild starts it empty
});
engine.onRebuild(() => { /* re-wire, re-materialize: local tables are gone */ });
```

## Select the service and grant

`brokerUrl` is the credential-service origin. Omit it to use same-origin
`/api/credentials/*` routes. `grantPath` selects the grant and is sent as
`?grant_path=...`; Cloudflare Access supplies the caller's identity.

```ts
import { brokerAwsManager } from "@habemus-papadum/aiui-cf-creds";

const manager = brokerAwsManager({
  brokerUrl: "https://creds.example.com",
  grantPath: "app",
});
// Pass this manager to adapters that share the same grant.
```

## Migration to 0.23

This release depends on the published browser credential SDK 0.7. Replace
broker option `key` with `grantPath`. The third argument to `brokerRoute()`
is now named `grantPath` and produces the canonical query parameter.
`MintClient` is now `RealtimeClient`; `FederatedMintOptions` is now
`FederatedCredentialOptions`. These names have no aliases in AIUI.

Actual API keys, `apiKey` callbacks, and the `OpenAIKeySource` contract keep
their existing names. Update external OpenAI identity mappings from JWT
claim `key` to `grant_path` when deploying the service migration.
