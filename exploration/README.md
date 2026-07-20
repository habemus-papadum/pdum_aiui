# `exploration/` — credential-delivery spikes

Standalone, runnable spikes exploring **how a user drives the channel's paid
vendor APIs without a raw, long-lived vendor key sitting in the client.** None of
these are wired into the channel; each is a self-contained mini **npm** project
(its own `node_modules`, outside the pnpm workspace) with heavy doc comments, a
`README.md`, and — where research was involved — a `RESEARCH.md`.

The channel talks to three vendors (the Anthropic key belongs to the `claude` CLI,
not the channel, so it's out of scope):

| Vendor | Env key | Channel surfaces |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | REST TTS (`gpt-4o-mini-tts`) + chat (`gpt-4o-mini`); realtime WS (`gpt-realtime-whisper`, `gpt-realtime-2`) |
| Gemini | `GEMINI_API_KEY` | Live WS (`gemini-3.1-flash-live-preview`) |
| ElevenLabs | `ELEVEN_LABS_API_KEY` | realtime STT WS (`scribe_v2_realtime`) |

## The three approaches

| | [`ephemeral-keys/`](./ephemeral-keys/) | [`proxy-jwt/`](./proxy-jwt/) | [`os-vault/`](./os-vault/) |
|---|---|---|---|
| **Idea** | mint short-lived **vendor** keys, scoped to our models | log into a site we control → **JWT** → stateless proxy holds the real keys | store the real keys in the **OS keychain**, resolve env→vault→die |
| **What's on the client** | a 15–20 min vendor token | a 15-min JWT (our credential) | nothing new — keys stay in the OS vault |
| **Vendor key exposure** | on the client, briefly | **never leaves our server** | on the local machine only (at rest in the vault) |
| **Covers OpenAI REST (TTS/chat)?** | ❌ no vendor mechanism | ✅ yes (we hold the key) | ✅ yes (it's the real key) |
| **One credential for all vendors?** | ❌ per-vendor mint | ✅ one JWT | n/a (real keys) |
| **Central revoke / billing / usage?** | ❌ | ✅ | ❌ |
| **Infra we must run** | none | a load-balanced proxy + issuer + billing | none |
| **Best for** | client-side streaming with least infra | a hosted convenience service with metered credits | local BYOK dev ergonomics |
| **Status** | ✅ live, 9/9 checks | ✅ live, 8/8 checks | ✅ live-verified on macOS |

They are **complementary, not competing**:
- `ephemeral-keys` and `proxy-jwt` are two answers to the *same* "no raw key on
  the client" problem — push a short-lived *vendor* credential out, vs. keep the
  vendor key server-side behind *our* short-lived credential. The proxy notably
  **closes the gap** the ephemeral spike found: OpenAI has no ephemeral option for
  its REST endpoints, but a proxy holding the key gates them with a JWT fine.
- `os-vault` is **orthogonal** to both — it's about where a bring-your-own-key
  user's real keys live locally (env or OS keychain), and composes with either
  (or neither).

## Run them

Each needs the relevant vendor keys in the environment. From this directory:

```sh
cd ephemeral-keys && npm install && npm run mint && npm run test-keys
cd ../proxy-jwt    && npm install && npm run demo
cd ../os-vault     && npm install && npm run store -- OPENAI_API_KEY && npm run resolve
```

See each subfolder's `README.md` for details, endpoints, and caveats. Headline
findings live in the per-folder `RESEARCH.md` files and, for the credential
mechanics, are summarized here:

- **OpenAI**: ephemeral `ek_` tokens are **realtime-only** (min 10s / max 2h TTL,
  model baked in); **no ephemeral path for REST** — hence the proxy.
- **Gemini**: `AQ.Ab8…` is a persistent *auth key*, not ephemeral; real ephemeral
  tokens are `auth_tokens/…` via `POST /v1alpha/auth_tokens`, 20-min OK,
  model-locked, connect via the `…Constrained?access_token=` endpoint.
- **ElevenLabs**: single-use `sutkn_…` via `/v1/single-use-token/realtime_scribe`,
  **15-min fixed** (can't reach 20), consumed on use, passed as `?token=`.
- **Proxy**: the channel's existing `baseUrl` / `url` / `apiKey` seams make
  BYOK-vs-proxy a **config swap, not a code change** — the proxy accepts the JWT
  from whichever slot each vendor's factory uses (`Bearer` / `xi-api-key` / `?key=`).
- **Vault**: shell out to `security` (macOS) / `secret-tool` (Linux), not a native
  module; watch the two macOS `security -w` corruption traps documented in
  `os-vault/RESEARCH.md`.

## Note

These are **explorations**, deliberately kept out of the packages/demos workspace
(no version lockstep, no packaging, never published). They exist to de-risk a
design decision, not to ship. Secrets they touch (`.aiui-cache/ephemeral-keys/keys.json`)
and each project's `node_modules` are gitignored.
