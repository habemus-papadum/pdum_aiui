# Ephemeral-key research notes

Distilled, implementation-facing findings per vendor. Verified against official
docs (July 2026). See `spec.ts` for the channel surface these scope down to.

## OBSERVED LIVE (this exploration, 2026-07-20) — the ground truth

`mint.ts` + `test-keys.ts` ran end-to-end against the real APIs. All mint/connect
worked; the expiry manifestations below are what the servers ACTUALLY sent (they
correct a couple of the doc/community guesses further down):

| Surface | Mint | Connect (works) | Expiry / invalid signal |
|---|---|---|---|
| openai realtime-linter (`gpt-realtime-2`) | ✓ `ek_…` | `session.created` | expired: socket **opens**, then `{"type":"error",…"message":"Ephemeral token expired"}` (NOT a 401 upgrade reject) |
| openai realtime-transcription (`gpt-realtime-whisper`) | ✓ `ek_…` | `session.created` (transcription_session) | same as above |
| gemini live (`gemini-3.1-flash-live-preview`) | ✓ `auth_tokens/…` | `setupComplete` | past new-session window: **close 1011** `"new_session_expire_time deadline exceeded"` (community had guessed 1008) |
| elevenlabs stt (`scribe_v2_realtime`) | ✓ `sutkn_…` | `session_started` | reused/malformed: `{"message_type":"auth_error","error":"You must be authenticated to use this endpoint."}` |
| openai rest-tts / rest-chat | — | — | **no ephemeral credential exists** (recorded as unavailable) |

Two gotchas found live: the Gemini live model rejects `responseModalities:["TEXT"]`
with close **1007** — it needs `["AUDIO"]`, baked into the token at mint. And the
`AQ.`-format Gemini parent key mints fine (the old `INVALID_ARGUMENT` bug is gone).

The channel uses three vendor credentials (the Anthropic key belongs to the
`claude` CLI, not the channel, so it is out of scope):

| Vendor | Parent env | Channel usage |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` (`sk-proj-…`, full) | REST TTS `gpt-4o-mini-tts`, REST chat `gpt-4o-mini`, realtime WS `gpt-realtime-whisper` / `gpt-realtime-2` |
| Gemini | `GEMINI_API_KEY` (`AQ.Ab8…`) | Live WS `gemini-3.1-flash-live-preview` |
| ElevenLabs | `ELEVEN_LABS_API_KEY` (`sk_f85…`, **restricted** — missing `user_read`) | Realtime STT WS `scribe_v2_realtime` |

---

## ElevenLabs — DONE

**Mint:** `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe`
header `xi-api-key: <parent>` → `200 { "token": "sutkn_…" }`.

- **TTL: fixed 15 minutes, NOT configurable.** No `ttl`/`expires_in` param exists.
  ⇒ the 20-minute target is unreachable here; 15 min is the ceiling. We record
  `ttlSeconds: 900` and flag the shortfall.
- **Single-use: the token is consumed on first use.** So a saved token works
  exactly once — fine for a one-shot smoke test.
- **Scope:** the token is minted for `realtime_scribe` specifically (the token
  type IS the scope). Finer per-model scoping isn't offered; `scribe_v2_realtime`
  is pinned by us at WS-connect via `model_id`.

**Use:** connect
`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=<sutkn_…>&audio_format=pcm_24000&include_timestamps=true`
— `token` query param replaces the `xi-api-key` header. No subprotocol.

**Success signal:** first inbound WS frame is
`{"message_type":"session_started","session_id":…,"config":{"model_id":"scribe_v2_realtime",…}}`.
Close immediately (before sending audio → no audio-minutes billed).

**Expiry / invalid:** documented frame `{"message_type":"auth_error","error":"…"}`.
Whether the failure rejects the HTTP upgrade (401/403) or opens the socket then
sends `auth_error` + close is **undocumented** — the test must capture both. Our
expiry test uses two cheap paths that need no 15-min wait:
  1. reuse an already-consumed token (single-use ⇒ should fault),
  2. a deliberately-garbage `sutkn_` token.

**Alternatives considered (not used):** Service-Account scoped keys
(`permissions:["speech_to_text"]`) have **no TTL field** (self-managed DELETE
only) and are gated to multi-seat admin workspaces — worse on every axis. The
Conversational-AI signed URL is agent-scoped, not raw STT.

---

## Gemini — DONE

**`AQ.Ab8…` is a persistent "Auth key"** (new service-account-bound format,
replaces `AIzaSy…`), **not** an ephemeral token. Real ephemeral tokens look like
`auth_tokens/<64-hex>`. So we must mint.

**Mint:** `POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens`
authenticated with the parent key. **Use the `x-goog-api-key: <parent>` header,
not `?key=`** — raw-curl `?key=` with `AQ.` keys has hit
`ACCESS_TOKEN_TYPE_UNSUPPORTED`; the header avoids it. Body:

```json
{
  "uses": 1,
  "expireTime": "<now+20min, RFC3339>",
  "newSessionExpireTime": "<now+2min, RFC3339>",
  "bidiGenerateContentSetup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "generationConfig": { "responseModalities": ["TEXT"] }
  }
}
```

Response `{ "name": "auth_tokens/<hex>", "expireTime":…, "newSessionExpireTime":…, "uses":1 }`.
The token is the **entire `name`** (keep the `auth_tokens/` prefix).

- **TTL fields:** `expireTime` = the session's message window (default 30 min,
  **max < 20 h**) ⇒ set `now+20min` ✓ (20-min target fully met, unlike
  ElevenLabs). `newSessionExpireTime` = the window to *start* a session (default
  60 s) — set short (2 min) for normal mint. `uses` = number of session starts
  (default 1; resumption doesn't count).
- **Scope:** `bidiGenerateContentSetup` with **no `fieldMask`** locks the entire
  session config — including the model — to exactly what we pass. Pins
  `models/gemini-3.1-flash-live-preview`.

**Use:** connect to a DIFFERENT endpoint (version + RPC name both change):
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=<auth_tokens/…>`
(or header `Authorization: Token <token>`). Still send a `{"setup":{…}}` frame;
its contents are ignored when fully locked.

**Success signal:** first inbound frame `{"setupComplete":{}}` (empty object; the
key's presence is the whole signal). Close — no generation spend.

**Expiry / invalid:** no documented exact close code. Community reports **1008
(policy violation)** for auth rejection, but 1008 is not unique to expiry —
capture the actual code+reason, don't hard-assert. `goAway` frames are a general
disconnect notice, not expiry-specific.
**Fast expiry test:** mint with `newSessionExpireTime = now + ~5 s`, wait past
it, then connect ⇒ new session rejected. No long wait. (A separate garbage
`auth_tokens/deadbeef` token covers the malformed-token path.)

**Caveat:** `AQ.` parent keys had an `authTokens.create` `INVALID_ARGUMENT` bug
(reportedly fixed May 2026). If minting fails, that's the first suspect — we'll
see it live.

---

## OpenAI — DONE (with a real gap)

**Split verdict: ephemeral keys exist ONLY for the realtime (WS) surfaces. The
REST surfaces (TTS acks, summarize) have NO vendor ephemeral mechanism.**

### Realtime (WS) — ephemeral works, 20 min OK
**Mint:** `POST https://api.openai.com/v1/realtime/client_secrets`
(header `Authorization: Bearer <parent sk-proj-…>`; NO `OpenAI-Beta` header — the
old `/v1/realtime/sessions` beta path is retired). Body:

```json
{ "expires_after": { "anchor": "created_at", "seconds": 1200 },
  "session": { "type": "realtime", "model": "gpt-realtime-2", "output_modalities": ["text"] } }
```

Response `{ "value": "ek_…", "expires_at": <unix>, "session": {…} }` — token is
**`value`**. `expires_after.seconds`: **min 10, max 7200, default 600** ⇒ 1200 (20
min) is fine ✓. The `session` config baked in IS the scope (realtime family +
that model).

The channel actually opens **two different** realtime sessions, so we mint two:
- **linter** — `session.type:"realtime"`, `model:"gpt-realtime-2"`; connect
  `wss://api.openai.com/v1/realtime?model=gpt-realtime-2`.
- **transcription** — `session.type:"transcription"`, with
  `audio.input.transcription.model:"gpt-realtime-whisper"` (NB `gpt-realtime-whisper`
  is a *transcription submodel*, not a top-level realtime model — it lives under
  `audio.input.transcription.model`, matching the channel's `session.update`).
  Connect `wss://api.openai.com/v1/realtime?intent=transcription`.

**Use:** header `Authorization: Bearer ek_…` (server-side `ws`; header, not
query, not subprotocol). **Success signal:** first server event
`session.created` (or `transcription_session.created`/`session.updated`). Close —
connections are free; billing starts only on a generated Response.

**Expiry (TRUE short-TTL test):** mint with `seconds:10`, wait >10 s, connect ⇒
`ws` fires `unexpected-response` with `res.statusCode == 401`, body
`{"error":{"code":"invalid_api_key",…}}`. (Browser native WS would only see a
1006 close — N/A here.)

### REST (TTS + chat) — NO ephemeral credential
`ek_` tokens are realtime-only; they do NOT work for `/v1/audio/speech` or
`/v1/chat/completions`. There is no TTL/expiry field on project API keys at all.
The only programmatic issuance is org-**Admin-key**-gated (service accounts +
project `model_permissions` allow-lists), with no auto-expiry — you own the
delete lifecycle. We don't have an Admin key, and it isn't really "ephemeral".
⇒ record this honestly as **unavailable**, don't fake it.
