# Ephemeral keys — exploration

Standalone spike (not wired into anything) that answers: **can the custom
channel's three vendor credentials be replaced with short-lived, scoped
ephemeral keys?** Two commands do the whole loop against the real APIs.

The channel uses three vendor keys (the Anthropic key belongs to the `claude`
CLI, not the channel, so it's out of scope):

| Vendor | Parent env var | Channel surface(s) |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | realtime WS (transcribe `gpt-realtime-whisper`, linter `gpt-realtime-2`) **+ REST** TTS `gpt-4o-mini-tts`, chat `gpt-4o-mini` |
| Gemini | `GEMINI_API_KEY` | Live WS `gemini-3.1-flash-live-preview` |
| ElevenLabs | `ELEVEN_LABS_API_KEY` | realtime STT WS `scribe_v2_realtime` |

## Run it

Needs the three **parent** keys in the environment (the same ones the channel
uses). Self-contained — its own `node_modules`, nothing from the workspace.

```sh
cd exploration/ephemeral-keys
npm install        # ws + tsx, one-time
npm run mint       # command A — mint 20-min scoped keys → cache
npm run test-keys  # command B — smoke-test them + prove expiry (~30s; short waits)
```

Minted keys land in `.aiui-cache/ephemeral-keys/keys.json` (gitignored, mode
`0600`). `test-keys` connects each to its real endpoint (no audio sent → no
spend) and then mints deliberately short-lived/invalid credentials to confirm
rejection.

## What the spike found

**Ephemeral keys cleanly cover every streaming (WebSocket) surface — which is
the client-exposed, security-sensitive part ephemeral keys exist for.** The one
gap is OpenAI's REST endpoints.

| Surface | Ephemeral mechanism | 20-min TTL? | Model-scoped? |
|---|---|---|---|
| OpenAI realtime (both) | `POST /v1/realtime/client_secrets` → `ek_…` | ✅ (max 2 h) | ✅ baked into session |
| OpenAI REST (TTS, chat) | ❌ **none exists** | — | — |
| Gemini Live | `POST /v1alpha/auth_tokens` → `auth_tokens/…` | ✅ (max <20 h) | ✅ locked in token |
| ElevenLabs STT | `POST /v1/single-use-token/realtime_scribe` → `sutkn_…` | ⚠️ **15 min fixed** | scope = the token type |

Caveats worth knowing before productionizing:

- **OpenAI REST has no ephemeral path.** `ek_` tokens are realtime-only; project
  keys have no TTL. Short-lived REST access would mean an org **Admin** key +
  service accounts + project `model_permissions`, self-deleted on a timer — no
  vendor-enforced expiry. Recorded in `keys.json` under `unavailable`, not faked.
- **ElevenLabs can't hit 20 min** — the single-use token is a fixed 15 min and is
  **consumed on first use** (so re-run `mint` before each `test-keys`).
- **Gemini** uses a *different* endpoint for ephemeral auth (`v1alpha …
  BidiGenerateContentConstrained?access_token=`, not `v1beta … BidiGenerateContent?key=`),
  and the live model needs `responseModalities:["AUDIO"]`.
- Each vendor presents the token differently: OpenAI `Authorization: Bearer`
  header, Gemini `?access_token=` query, ElevenLabs `?token=` query.

Full per-vendor detail + the live-observed expiry signals are in
[`RESEARCH.md`](./RESEARCH.md).

## Files

| File | Role |
|---|---|
| `spec.ts` | Firmly-known channel surface (endpoints, models, auth) + cache paths + data model |
| `mint-core.ts` | Per-vendor mint functions (the live API calls) |
| `test-core.ts` | Per-vendor connect + success/rejection classification |
| `util.ts` | Keys-file IO, logging, the WebSocket probe |
| `mint.ts` | **Command A** — mint 20-min keys, record unavailable surfaces, save |
| `test-keys.ts` | **Command B** — smoke test cached keys + expiry test |
| `RESEARCH.md` | Vendor research notes + live-observed ground truth |
