# aiui-cf-creds — broker-backed ephemeral credentials for aiui apps

Status: IMPLEMENTED — `packages/aiui-cf-creds`, 2026-08-11, against the kit's 0.2.0
line. Deltas from the sketch below, all downstream of kit 0.2.0's own API: the
`/mosaic` bridge is `brokerConnector(base, options)` — it WRAPS the base connector
the app already constructs (seismos-style `wasmConnector(...)`) rather than
constructing one, mirroring the kit's `credentialAwareConnector`, and takes the
required `region` (a D3 baked fact the sketch missed); `scribeConnectUrl` passes the
kit's socket options through; `brokerUrl` everywhere is the broker's ORIGIN (the
kit's conventional `/api/credentials/*` paths are appended — one deployment fact at
the composition root); `transcriptionKeySource` defaults its model to the channel's
proven `gpt-realtime-whisper`; `/oracle` exposes a structural `MintClient` injection
seam so tests stub the SDK surface without this package ever naming `openai` types.
Open question 1 settled: `aiui-cf-creds`, name the thing that exists.

Originally drafted 2026-08-08. Grounded in two live spikes: this repo's
`exploration/ephemeral-keys/` (2026-07-20, the vendor ephemeral-credential matrix) and a
2026-08-08-adjacent probe (2026-08-07) against a deployed credential broker, which
verified the one fact this proposal newly depends on: **a workload-identity-federated
bearer is authorized to mint realtime client secrets** — for both `realtime` and
`transcription` session types — and the resulting `ek_` opens live sessions from a
browser-shaped WebSocket. No API key existed anywhere in that chain.

## What this is

A new workspace package, `packages/aiui-cf-creds`: adapters that let aiui components
draw their ephemeral credentials from a **credential broker** built on the
[`cf_browser_credentials`](https://github.com/habemus-papadum/cf_browser_credentials)
kit (`@habemus-papadum/cf-*` on npm). It is a bridge package in the strict sense: it
depends on the kit and on aiui's existing credential seams, implements one against the
other, and adds no seam of its own. Apps that don't use a broker never install it;
nothing in `aiui-viz` or `aiui-oracle` changes.

The target apps are **serverless/static aiui deployments** — the app oracle's home
turf (`docs/proposals/aiui-oracle.md`, "The two oracles"). Today a static app's only
key flows are a pasted key and the dev-server key; a mint endpoint requires "a channel,
a cloud function" (`aiui-oracle/src/keys.ts`, `StandardKeySourcesOptions.mintUrl`).
This package adds the third leg: a static page, served from a broker-fronted origin,
that mints its own short-lived credentials with **no vendor key existing anywhere** —
not in the page, not in a server, not at all.

## Context 1: the cf_browser_credentials kit

The kit assumes one deployment shape: a static site plus a small Cloudflare Worker
**credential broker**, both behind Cloudflare Access on a single origin. The broker
owns the path `/api/credentials/*`; the static site owns everything else. Auth is the
user's Access cookie — the browser sends `credentials: "include"`, the worker treats a
missing Access JWT header as a tripwire and never inspects identity itself. During
development, `vite dev` on any loopback port talks to a *deployed* broker cross-origin,
authenticated by the same cookie (the broker echoes CORS for loopback origins only) —
no local secrets, no proxy.

**The entire client contract is one request**: `GET /api/credentials/<provider>` →
JSON containing an ISO-8601 `expiration`. Everything else is convention. That smallness
is what makes this bridge cheap.

The kit's taxonomy — **credential species** — is load-bearing for this design:

| Species | Example | Browser rule |
|---|---|---|
| **session** | AWS role credentials via STS AssumeRole (~2 h) | cache; refresh at `expiration − margin` |
| **federated** | OpenAI workload identity — *no key exists* | mint a ≤300 s OIDC JWT on demand; the vendor SDK exchanges it internally |
| **single-use** | ElevenLabs realtime scribe tokens (15 min, fixed) | fetch before **every** connect; never cache — the token dies at first use |

Kit packages this bridge consumes:

- `cf-browser-credentials` — `CredentialManager<C>`: `get()` (cached), `refresh()`
  (deduped), `onRotate(fn)`. Generic over any payload with an `expiration`.
- `cf-creds-aws` — `createAwsCredentialManager()` (default URL: same-origin
  `/api/credentials/aws`), `createSignedFetch()` for SigV4-signed S3 reads.
- `cf-creds-openai` — `awsSubjectTokenProvider()` (broker creds →
  `sts:GetWebIdentityToken`, ES384, audience `https://api.openai.com/v1`) and
  `createFederatedOpenAI()` (the openai SDK's `workloadIdentity` option does the
  exchange and re-invokes the provider as needed). The OpenAI service account behind
  this is created **keyless** — federation is the sole way in.
- `cf-creds-elevenlabs` — `fetchScribeToken()`, `scribeSocketUrl()` (token rides a
  query param; browsers can't set WebSocket headers). Deliberately ships no manager:
  caching a single-use token hands out a corpse.
- `cf-creds-mosaic` — wraps any Mosaic `Connector` so every query (including SQL that
  Mosaic generates itself for brushes and linked selections) first ensures current AWS
  credentials are installed in DuckDB-wasm. Exists because DuckDB stores credential
  *strings*, not provider callbacks.

## Context 2: the aiui seams this targets

**The oracle's `KeySource`** (`aiui-oracle/src/types.ts`) is already a broker
interface: `describe()` plus `credential(session) → Promise<OracleCredential>`, where
`OracleCredential` is `{ ek, expiresAt, source? }`. The combinators exist too:
`chainKeySource` (first source to produce wins, refusals surface loudly),
`cachingKeySource` (one `ek_` mints multiple sessions until TTL, so caching is
correct), `standardKeySources` (paste-key → dev-key → optional mint URL). This package
adds a fourth source species to that chain; it changes nothing about the chain.

**aiui-viz owns no credentials** and must stay that way. The package's one network
call is an asset fetch; `MosaicView` accepts a structural coordinator and never
constructs one; `aiui-global.ts` states the policy: "The page dials nothing;
connectivity arrives from OUTSIDE." That inversion is precisely why this bridge slots
in from the app side without touching the framework.

**The STT input component** (future, separate proposal): a standalone
speech-to-text input surface in the spirit of the intent tool's talk lanes, for use in
arbitrary aiui apps. Two viable vendor flavors, both already ephemeral-capable:
ElevenLabs realtime scribe (single-use tokens) and OpenAI `transcription`-type realtime
sessions (`ek_`, verified — see below). This package supplies the credential side of
both so that component can stay transport-pure like `SpeechPlayer` is.

## The new fact, and what it dissolves

The oracle proposal settled that browser minting is CORS-open and that minting stays
server-side "purely for **key custody** — the parent key must never reach the client"
(`docs/proposals/aiui-oracle.md`, Auth). Federation dissolves the premise: **there is
no parent key**. The custody argument evaporates, and browser-side minting flips from
"possible but wrong" to simply correct.

Verified live against a deployed broker (2026-08-07), the full chain browser-side:

```
broker session creds (GET /api/credentials/aws, Access cookie)
  → sts:GetWebIdentityToken            ES384 OIDC JWT, sub = role ARN, ≤300 s
  → SDK workloadIdentity exchange      internal, auto-refreshed
  → POST /v1/realtime/client_secrets   AUTHORIZED — the question under test
  → ek_ …                              opens session via WebSocket subprotocol
```

- Both session types minted and connected: `realtime` (connect with `?model=`) and
  `transcription` (bare URL — the session config attached at mint applies).
- Auth presentation was the browser one end-to-end: `openai-insecure-api-key.<ek_>`
  subprotocol, no headers (the probe used a WebSocket client that *cannot* set
  headers, deliberately).
- The openai SDK auto-allows browser use when the key starts `ek_` — no
  `dangerouslyAllowBrowser` on the connect side.

Consequences: `createMintBackend`/`runMintServer` become *optional* deployment choices
rather than the only custody-correct path, and the mint-endpoint leg of
`standardKeySources` is unnecessary for broker-fronted apps.

## Design decisions

**D1 — dependency direction: the bridge lives here and depends on the kit.** Not the
reverse, and not in `aiui-viz` core. Two reasons. First, aiui-viz has no credentialed
calls — adding a credential stack to it would tax every consumer and cut against the
inversion that makes its components adaptable. Second, stability asymmetry: the kit's
contract (one GET, JSON with `expiration`) is tiny and frozen; aiui's interfaces are
solid-2.0-beta and moving. A bridge rides with the fast-moving side and pins the
stable one. (The kit has precedent for bridges in the other direction —
`cf-creds-mosaic`, `cf-creds-zarr` — and aiui's structural interfaces would permit a
zero-runtime-dep implementation over there. Rejected for the stability reason, not for
feasibility.)

**D2 — no deployment identity in the package, by construction.** Defaults are the
kit's same-origin path conventions (`/api/credentials/aws`, `/api/credentials/
elevenlabs`) — deployment-relative, so an app published onto any broker-fronted origin
works with zero config. Dev and cross-origin cases pass an explicit `brokerUrl` at the
app's composition root. No literal hostname, provider ID, or account fact may appear
in this package; test fixtures use invented values.

**D3 — federation facts are baked at the composition root.** `identityProviderId`,
`serviceAccountId`, and the STS region are per-deployment, non-secret, and required
options. Deploying apps copy their own values, the same way they already bake asset
URLs (`aiui-viz/src/duckdb.ts` refuses `import.meta.env` for exactly this class of
fact). No runtime lookup of non-secrets.

**D4 — species semantics are API shape, not documentation.** The session manager
caches and rotates; the federated sources mint on demand and let the SDK own exchange
refresh; the single-use source exposes *no* caching surface at all — mint-per-connect
is enforced by construction, mirroring `cf-creds-elevenlabs`'s own refusal to ship a
manager. A future reader must not be able to hold a scribe token wrong.

## The package

`packages/aiui-cf-creds`. Runtime deps: `@habemus-papadum/cf-browser-credentials`,
`cf-creds-aws`, `cf-creds-openai`, `cf-creds-elevenlabs`, `cf-creds-mosaic`, plus
their peers (`@aws-sdk/client-sts`, `openai`). Workspace dep on `aiui-oracle` for
**types only** (`import type { KeySource, OracleCredential }`). Subpath exports so a
Mosaic-only app never pulls the vendor SDKs:

```
aiui-cf-creds/oracle      aiui-cf-creds/stt      aiui-cf-creds/mosaic
```

### `/oracle` — the federated KeySource

```ts
export interface FederatedMintOptions {
  /** Reuse the app's manager; default constructs one against `brokerUrl`. */
  manager?: CredentialManager<AwsCredentials>;
  /** Default: same-origin `/api/credentials/aws`. Dev passes the deployed broker. */
  brokerUrl?: string;
  /** Baked per-deployment facts (D3). */
  region: string;
  identityProviderId: string;
  serviceAccountId: string;
  /** ek_ TTL; vendor bounds 10–7200 s. Default 600. */
  expiresAfterSeconds?: number;
}

/** Mints `ek_` entirely browser-side: broker creds → GetWebIdentityToken →
 *  SDK exchange → POST /v1/realtime/client_secrets. */
export function federatedKeySource(options: FederatedMintOptions): KeySource;
```

`credential(session)` forwards the wire session config as the secret's baked default
(a default, not a sandbox — TTL is the real bound, per the oracle proposal) and maps
`{ value, expires_at }` → `{ ek, expiresAt, source: "cf-federation" }`. Composition in
an app:

```ts
const keySource = chainKeySource([
  pasteKeySource(localStorage, {}),          // a pasted key still trumps everything
  devKeySource("openai", {}),                // dev serve still just works
  cachingKeySource(federatedKeySource({ region, identityProviderId, serviceAccountId })),
]);
```

`cachingKeySource` is correct here for the same reason it is over `mintingKeySource`:
one `ek_` opens multiple sessions until it expires.

### `/stt` — both flavors for the speech-input component

```ts
/** ElevenLabs scribe: single-use. One call = one connect. No cache exists. */
export function scribeConnectUrl(options?: { brokerUrl?: string }): Promise<string>;

/** OpenAI transcription-type sessions: a KeySource whose minted secrets carry
 *  `{ type: "transcription", audio: { input: { transcription: { model } } } }`. */
export function transcriptionKeySource(
  options: FederatedMintOptions & { transcriptionModel?: string },
): KeySource;
```

The component itself (separate proposal) chooses a flavor per app; its contract with
this package is "give me something I can open a socket with," nothing more.

### `/mosaic` — the credential-installing connector

```ts
/** wasmConnector wrapped so every query first installs current broker AWS creds
 *  into DuckDB (CREATE OR REPLACE SECRET, SET s3_* fallback). */
export function brokerWasmConnector(options?: {
  manager?: CredentialManager<AwsCredentials>;
  brokerUrl?: string;
}): Promise<Connector>;
```

The app hands the result to the coordinator it already constructs; `MosaicView` never
learns credentials exist. Views survive rotation because they store S3 paths, not
credentials.

## What this package is NOT

- **Not a UI.** No widgets, no status surfaces — the oracle's ledger already
  attributes auth via `OracleCredential.source`.
- **Not a server.** The broker worker is the kit's `cf-creds-worker`, deployed by the
  site that fronts the app. This package is browser-only.
- **Not a general auth framework.** It adapts exactly one contract — the kit's — to
  exactly the seams aiui already has. A different broker gets a different bridge.
- **Not a change to `aiui-oracle` or `aiui-viz`.** No new events, no interface edits;
  if the bridge needs a seam that doesn't exist, that seam is its own proposal.
- **Not a carrier of deployment identity** (D2). If a hostname or provider ID appears
  in this package outside a test fixture, that is a bug.

## Open questions

1. **Name.** `aiui-cf-creds` states the dependency honestly; `aiui-broker-creds` would
   survive a future non-Cloudflare broker implementing the same contract. Weak
   preference for `aiui-cf-creds` — name the thing that exists.
2. **Bundle weight.** `@aws-sdk/client-sts` + `openai` land ~80 kB gzipped in the
   probe page's whole bundle. Acceptable for an opt-in subpath; worth re-measuring in
   a real app before declaring victory.
3. **Gemini.** The kit has no Gemini species yet; the oracle is OpenAI-first. When a
   Gemini Live species exists (ephemeral `auth_tokens` verified in
   `exploration/ephemeral-keys/`), it becomes another `/oracle` source here — nothing
   in this design precludes it.
4. **Scribe mint volume.** Single-use means one broker round-trip per talk turn.
   Negligible at single-user scale; a shared deployment would want the broker's own
   rate posture reviewed, not client-side caching (which cannot exist — D4).
