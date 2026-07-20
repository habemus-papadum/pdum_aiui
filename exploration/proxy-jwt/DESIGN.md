# Proxy + JWT convenience service — design

A second answer to the same problem the [ephemeral-keys spike](../ephemeral-keys/)
tackled: **how does a user drive the channel's paid vendor APIs without their raw
long-lived keys sitting in the client?** Ephemeral keys push short-lived *vendor*
credentials to the client. This design does the opposite — it keeps the vendor
keys entirely server-side behind a proxy the user reaches with *our* short-lived
credential (a JWT), and bills them for usage.

The two are complementary, and the proxy notably **closes the gap the ephemeral
spike hit**: OpenAI has no ephemeral credential for its REST endpoints (TTS,
chat), but a proxy holding the real key gates them with a JWT just fine.

## The two modes the channel is instrumented for

The channel already exposes every seam needed; the mode is pure configuration
(verified in `client-demo.ts`, section 1):

| | Base URL / WS URL | Auth (`apiKey` slot) |
|---|---|---|
| **Bring-your-own-key (BYOK)** | vendor default (`api.openai.com`, …) | the user's real vendor key |
| **Convenience (proxy)** | our proxy (`proxy/rest/openai`, `proxy/ws/openai/…`) | a 15-min JWT |

Channel seams that make this a config swap, not a code change:
- REST: `openaiSummarizer({ baseUrl, apiKey })`, `openaiSpeaker({ baseUrl, apiKey })`
  — auth is `Authorization: Bearer ${apiKey}`, so `apiKey = <jwt>` + `baseUrl = <proxy>`
  just works.
- WS: every session takes `{ url, apiKey }` (`realtime.ts`, `openai-live.ts`,
  `gemini-live.ts`, `elevenlabs-realtime.ts`).

The one subtlety: each vendor's socket factory puts the credential in a different
slot — OpenAI `Authorization: Bearer`, ElevenLabs `xi-api-key`, Gemini `?key=`.
The proxy therefore accepts the JWT from **any** of those slots
(`extractIncomingToken` in `config.ts`), so no per-vendor client change is
needed. The channel keeps doing exactly what it does; only the URL and the token
value change.

## Credential lifecycle (OIDC → JWT)

```
 user ──(1) OIDC login (GitHub)──►  issuer (our website)
      ◄─(2) 15-min JWT ────────────  · verifies GitHub identity
                                     · looks up credit balance
 user ──(3) API calls w/ JWT ────►  proxy replica (any of N)
                                     · verify sig+exp locally (JWKS)
                                     · check revocation (shared)
                                     · check balance (shared)
                                     · inject REAL vendor key
                                     ├─(4)──► vendor API
                                     · meter usage → billing pipeline
 user ──(5) refresh before exp ──►  issuer  (re-mint, or force re-auth)
```

- **Login (OIDC).** The user signs in with GitHub. The issuer verifies the OIDC
  `id_token`, maps it to an account, and mints a JWT. *In this spike the identity
  step is stubbed* (`POST /login {user}`); everything downstream is real.
- **JWT.** Ed25519 (EdDSA), 15-minute `exp`, claims `{sub, jti, iat, exp, iss,
  aud, scope}`. `jti` is the unit of revocation; `aud` pins the token to this
  proxy; `scope` is a coarse vendor allow-list (extensible to per-surface).
- **Refresh / re-auth.** Short `exp` means the client re-mints every ~15 min. The
  issuer decides whether a silent refresh is allowed or a full re-auth is
  required (balance exhausted, suspicious activity, credential age) — this is
  where "at some point require a full auth flow again" lives.

## Why the proxy is stateless (and how it still revokes)

Each proxy replica needs only two pieces of **shared, read-only** state, so any
replica can serve any request behind a load balancer with no session affinity:

1. **JWKS** — the issuer's public key, fetched once. Verification of
   signature + expiry is then purely local (no issuer round-trip per request).
   This is why the token is **asymmetric** (EdDSA), not an HMAC shared secret.
2. **Revocation view** — a denylist of revoked `jti`s. In this spike the proxy
   polls the issuer's `/revocations` with a short cache; **in production this is a
   shared cache (e.g. Redis) queried by `jti`**, with entries that auto-expire
   when the token would have expired anyway (so the list stays tiny — bounded by
   15 min of issuance).

Revocation strategy trade-off:
- **Pure short-expiry (softest):** no denylist at all; "revoke" = stop
  re-issuing. Fully stateless, but revocation latency is up to the 15-min TTL.
- **Shared `jti` denylist (what this implements):** immediate hard revocation,
  at the cost of one shared cache lookup (cacheable for a few seconds). Still
  "stateless" in the load-balancing sense — no per-user state pinned to a replica.

The 15-minute TTL bounds blast radius even if the denylist lookup is briefly
stale.

## Metering, balance & billing

The proxy is the natural metering point — it sees every call and holds the real
usage signal:
- **Pre-request:** reject with `402` if the subject's balance is exhausted
  (demonstrated: `no-credit user → 402`).
- **Post-request:** emit a usage event. REST responses carry real token `usage`
  (OpenAI chat/TTS) → charge by tokens; streaming WS is metered by traffic here
  (a stand-in — production parses the vendor's realtime `usage` events).
- **`GET /usage`** exposes per-subject events + balance — this is what "show the
  user their real-time usage" reads.

In this spike balances + events are **in-memory** in the proxy. In production:
- usage events flow to an external metering pipeline (queue → billing DB);
- the balance check reads a shared store (so all replicas agree);
- "buy credits" is a separate flow on the issuer website (Stripe → balance top-up);
- reconciliation handles the race between concurrent replicas (idempotent event
  ids, eventually-consistent balance with a soft overage allowance).

## Security posture

- **Vendor keys never leave the server.** The client only ever holds a
  15-min, revocable, audience-pinned JWT. Compromise is bounded and cuttable.
- **The proxy is a high-value target** — it holds every vendor key and can spend
  real money. It must run with least privilege, tight egress (only the vendor
  hosts), per-subject rate limits, and anomaly detection feeding revocation.
- **`aud` + `scope`** stop a token minted for one service/vendor being replayed
  elsewhere. `scope` should tighten to per-surface before production.
- **Metering is also abuse control**: the balance gate caps how much a stolen
  token can spend before its 15 min are up.

## What's real vs mocked in this spike

| Real | Mocked / simplified |
|---|---|
| EdDSA JWT sign/verify, JWKS, `jti` revocation | GitHub OIDC identity step (stubbed `/login`) |
| Stateless verify from JWKS across separate processes | revocation store = issuer memory over HTTP (prod: Redis) |
| Real REST + WS pass-through to OpenAI with server-side key injection | balances/usage in-memory (prod: external pipeline + shared store) |
| `402` balance gate, expiry & revocation rejection | WS metering by bytes (prod: parse vendor usage events) |
| Accepting the JWT from Bearer / `xi-api-key` / `?key=` | "buy credits", refresh policy, rate limiting |

## Relationship to the ephemeral-keys spike

| | Ephemeral keys | Proxy + JWT |
|---|---|---|
| Credential on the client | short-lived **vendor** key | short-lived **our** JWT |
| Vendor key exposure | on the client (briefly) | never leaves our server |
| OpenAI REST (TTS/chat) | **no mechanism** | ✅ covered |
| One credential for all vendors | no (per-vendor mint) | ✅ yes |
| Central revoke / billing / usage | no | ✅ yes |
| Infra we must run | none | a load-balanced proxy + issuer + billing |
| Extra latency / failure surface | none | one hop through us |

They compose: BYOK users can still use ephemeral keys for the streaming surfaces;
convenience users go through the proxy for everything, including the REST surfaces
ephemeral keys can't cover.
