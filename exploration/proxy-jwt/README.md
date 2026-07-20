# Proxy + JWT — exploration

Standalone spike (not wired into anything) for the **convenience-service** model:
instead of the client holding vendor keys, the user logs into a site we control,
gets a short-lived **JWT**, and points the channel at a **stateless proxy** that
holds the real vendor keys, forwards their calls, and meters usage for billing.

The channel supports this as a **config swap** — its existing `baseUrl` / `url` /
`apiKey` seams point at either the vendor (bring-your-own-key) or the proxy
(JWT). See [`DESIGN.md`](./DESIGN.md) for the architecture; this README is how to
run it.

## Run it

Self-contained (own `node_modules`: just `ws` + `tsx`). Needs `OPENAI_API_KEY` in
the env for the live pass-through checks (other vendor keys optional).

```sh
cd exploration/proxy-jwt
npm install
npm run demo        # boots issuer + proxy in-process, runs the whole story
```

`npm run demo` proves, end-to-end against the real OpenAI API:

1. the two instrumentation modes (BYOK vs proxy) are only a base-URL + auth change
2. login → 15-minute JWT
3. **proxy REST** — OpenAI chat through the proxy with the JWT (real key server-side)
4. **proxy WS** — OpenAI realtime through the proxy with the JWT (`session.created`)
5. **BYOK** — the same call made directly with the real key
6. failure modes — expired JWT → 401, revoked JWT → 401, no credit → 402, bad WS token → 401
7. per-user usage + balance from `GET /usage`

Last run: **8/8 checks pass.**

### Or run the pieces as separate processes (the load-balanced shape)

```sh
npm run issuer      # terminal 1 — the mock OIDC→JWT issuer (:8788)
npm run proxy       # terminal 2 — a stateless proxy replica (:8789, fetches JWKS from the issuer)

JWT=$(curl -s -XPOST localhost:8788/login -H content-type:application/json -d '{"user":"github:me"}' | jq -r .token)
curl -XPOST localhost:8789/rest/openai/v1/chat/completions \
  -H "authorization: Bearer $JWT" -H content-type:application/json \
  -d '{"model":"gpt-4o-mini","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
```

Run `npm run proxy` twice on different ports to see N stateless replicas verify
the same JWT independently from the shared JWKS.

## Endpoints

Issuer (`:8788`): `POST /login` · `POST /revoke {jti}` · `GET /.well-known/jwks.json` · `GET /revocations`
Proxy (`:8789`): `POST /rest/<vendor>/<subpath>` · WS `/ws/<vendor>/<surface>` · `GET /usage`

WS surfaces routed: `openai/realtime-transcription`, `openai/realtime-linter`,
`elevenlabs/stt-realtime`, `gemini/live`. REST: `openai/*` (the surfaces with no
ephemeral-key option).

## Files

| File | Role |
|---|---|
| `jwt.ts` | Dependency-free EdDSA JWT + JWKS on `node:crypto` |
| `config.ts` | Ports, TTL, vendor route table, the `extractIncomingToken` / `injectUpstreamAuth` helpers |
| `issuer.ts` | Mock OIDC→JWT issuer (login, revoke, JWKS, revocations) |
| `proxy.ts` | The stateless proxy: verify → balance-gate → inject real key → forward REST+WS → meter |
| `client-demo.ts` | End-to-end demo (**`npm run demo`**) |
| `DESIGN.md` | Full architecture, revocation/billing/security, relation to the ephemeral-keys spike |

## Caveats (see DESIGN.md for the full list)

- Identity is stubbed — `/login` mints for any `{user}`; production verifies a real GitHub OIDC token.
- Balances/usage are in-memory in the proxy; production uses an external metering pipeline + shared balance store.
- Revocation is the issuer's memory over HTTP; production is a shared cache (Redis) keyed by `jti`.
- WS usage is metered by bytes here; production parses each vendor's realtime `usage` events.
