# aiui-stt — realtime speech-to-text as a pencil-shaped component

Status: PROPOSED — drafted 2026-08-08. Companion to `aiui-cf-creds.md` (the credential
side). Grounded in the channel's shipped two-engine STT path — the wire facts
hard-won and recorded in `aiui-claude-channel/src/{elevenlabs-realtime,realtime,
intent-stt}.ts` — plus `exploration/ephemeral-keys/` (2026-07-20) and the 2026-08-07
broker probe that verified `transcription`-type client secrets end-to-end from a
browser-shaped client.

## What this is

A new package, `packages/aiui-stt`: a **pencil-shaped component** for realtime
speech-to-text. The contract is the pencil's, with text in place of ink: start a
session, feed it audio, watch a stream of cumulative text deltas, and know when a
segment is final. Primary engine: **ElevenLabs Scribe v2 realtime**; second engine:
OpenAI `transcription`-type realtime sessions. Both already ship in the channel behind
one seam — this package is that seam's browser-side homologue.

It is loosely derived from the intent panel's STT. The intent panel MAY later adopt it
— that is not a requirement, but (as with the oracle: "initially independent of the
intent client, designed so it can later be embedded there without chaos") nothing in
this design may preclude it.

## The model question, settled

The question that shaped this proposal: is STT **Mosaic-shaped** (a view-side adapter,
plausibly another aiui-viz entry point) or **pencil/oracle-shaped** (its own
session-owning package)? The litmus is: *who owns the live session?*

| | Mosaic support in viz | pencil / oracle | STT |
|---|---|---|---|
| Live machinery owned by | Mosaic itself (coordinator/clients) | the package (session engine) | the package (session engine) |
| Network calls | none — the app supplies a connector | owned (relay WS / WebRTC / vendor) | owned (vendor WS) |
| Credentials | none | pairing / `KeySource` | **per-connect token — single-use for Scribe** |
| Completion semantics | n/a (queries) | stroke end | segment final |

Verdict: **pencil/oracle**. `MosaicView` could live inside aiui-viz because Mosaic
owns all the live machinery and viz merely hosts a view — "the page dials nothing;
connectivity arrives from OUTSIDE" (`aiui-viz/src/aiui-global.ts`). STT has no
external framework to delegate to: the component itself must connect, mint a
credential per connect, segment audio, correlate finals, and recover from drops.
Putting that in viz would introduce the library's first network-owning,
credential-consuming code and spend the exact invariant that keeps viz trivially
deployable anywhere.

One half of the feature IS Mosaic-shaped, and — usefully — **it already lives in
viz**: `LiveDiffText` (`aiui-viz/src/modal/flash.ts`) is the diff-updating streaming
text renderer (appends render clean, revisions flash word-diffs and settle;
`LIVE_FLASH_MS`/`SETTLE_FLASH_MS`, pluggable `DiffRunClasses`). The turn preview
already consumes it as a Solid island (`turn-preview-rows.tsx`). The display side of
this proposal is therefore: **nothing new**. (An earlier sketch of this proposal
imagined a standalone streaming-text package; the widget existing in viz-modal makes
that moot.)

## Context 1: what ships today — the channel path

The intent tool's STT is a two-hop relay: browser mic PCM → channel over the local
socket → vendor over a server-held-key WebSocket; transcripts return as the channel's
own `transcript-delta` / `transcript-final` events. The browser never dials a vendor.

The part that matters here is the seam the channel already built
(`aiui-claude-channel/src/realtime.ts`), because it is exactly the engine interface
this package needs, already proven against both vendors:

- **`RealtimeSession`** — `appendAudio(segment, bytes)`, `commit(segment)`,
  `discard(segment)` (sub-floor strays must not prepend to the next segment), and a
  drain that resolves when every committed segment has finaled or a timeout names the
  outstanding ordinals loudly.
- **`RealtimeCallbacks`** — `onDelta(segment, cumulativeText)` (the load-bearing
  contract: every engine re-sends the **cumulative** text, so a partial that gets
  *shorter* is the vendor revising itself, not data loss), `onFinal(segment,
  result)` with latency/model/cost and optional word data, `onError(message,
  segment?)` with per-segment attribution, `onDiagnostic?` for protocol
  observability.
- "The vendor difference is confined to the open" (`intent-stt.ts`) — one callbacks
  wiring drives either engine.

Equally transferable: the recorded Scribe v2 wire facts (`elevenlabs-realtime.ts`) —
config rides the connect URL (`model_id`, `audio_format=pcm_24000`,
`include_timestamps=true`, optional `language_code`, repeatable keyterms); one message
shape `{ audio_base_64, commit, sample_rate }` where a commit is the same message with
`commit: true`; **no ids anywhere** — correlation is FIFO positional; the timestamped
committed transcript is authoritative; the ~40 s self-commit behavior on continuous
utterances; `commit_throttled` and friends. And the OpenAI-side facts: token-level
logprobs folded to word-level confidences (no timestamps on that wire), the 100 ms
commit minimum, per-engine discard floors. **This protocol knowledge is already paid
for.** The browser engine ports it; it does not rediscover it.

What does NOT transfer: the lowering pipeline, turn/compose semantics, talk lanes,
trace stages. Those are the intent tool's; this package stops at segments and finals.

## Context 2: why browser-direct is now possible

Both engines have verified ephemeral mechanisms (`exploration/ephemeral-keys/`, plus
the 2026-08-07 probe):

| Engine | Credential | Presentation | Lifecycle rule |
|---|---|---|---|
| Scribe v2 realtime | single-use token, 15 min fixed TTL | `?token=` query param | mint per connect; **never cache** — dead at first use |
| OpenAI transcription session | `ek_` client secret (10 s–7200 s) | `openai-insecure-api-key.<ek_>` subprotocol | one `ek_` opens multiple sessions within TTL; cacheable |

Two custody models must both be served, through the same injected seam:

- **Broker-fronted static apps** — `aiui-cf-creds/stt` supplies `scribeConnectUrl()`
  and `transcriptionKeySource()`; no vendor key exists anywhere (see that proposal).
- **Channel-hosted apps** — the channel keeps the parent key and mounts a mint route,
  the oracle-mint precedent (`createMintBackend`): the panel gets a token per turn,
  the key never leaves the channel process.

One component, both custody models, zero forks — that is what the seam buys.

## Design decisions

**D1 — its own package; not a viz entry point.** Per the model verdict. aiui-viz's
credential-free, network-free invariant is cheap to keep and expensive to claw back.

**D2 — port the channel's seam; do not invent a new one.** The browser engine's
session interface mirrors `RealtimeSession` (`appendAudio` / `commit` / `discard` /
drain-with-loud-timeout) and its event surface mirrors `RealtimeCallbacks`, cumulative
`onDelta` contract included. Vendor difference confined to the transport open, as in
the channel. Segmentation is **client-committed (push-to-talk) first** — the shipped,
understood model; vendor VAD becomes a `capabilities` entry when an engine earns it.

**D3 — credentials are injected, never owned.** Each transport takes a token/key
source; the package contains no URLs beyond same-origin defaults inherited from its
sources, and no custody logic. Scribe's source API is shaped so caching cannot be
expressed (one call = one connect), mirroring `cf-creds-elevenlabs`'s refusal to ship
a manager.

**D4 — audio is injected; the mic is a separable implementation.** The engine
consumes an `AudioSource` (PCM16 frames + sample rate + start/stop + a level signal)
the way `SpeechPlayer` consumes injected `createAudio`/`createContext` — same
inversion, source instead of sink. `aiui-stt/mic` provides the real one: getUserMedia
flow, device picker UI, worklet capture, level meter. Happily both engines take
24 kHz PCM16 (`sample_rate: 24000` on the Scribe wire; 24 kHz on the OpenAI wire), so
one capture path serves both. The oracle's transports also need mic plumbing —
`aiui-stt/mic` is written to be promotable to a shared package later, but no shared
dependency is created now.

**D5 — the reactive surface is signals, produced by an adapter.** Following the
pencil's `inkSignals(source)` pattern (`aiui-pencil/src/reactive.ts`): the engine is
imperative + callbacks; `sttSignals(engine)` lifts it into Solid — `status`, the open
segment's cumulative `partial`, the append-only `finals` list. Cell-ness is NOT baked
in: an app that wants the transcript as a cell lifts the signal itself — and an app
that does so has incidentally made dictation visible to the oracle's tool surface.

**D6 — display reuses `LiveDiffText`.** The cumulative-partial contract (D2) is
exactly what `LiveDiffText.update()` wants — appends extend, revisions flash. At most
this package documents the island pattern; it ships no renderer.

## The package (API sketch — shapes, not signatures of record)

```ts
// aiui-stt
export interface SttCapabilities {
  wordTimestamps: boolean;   // Scribe yes; OpenAI wire no
  wordLogprobs: boolean;     // both, differently produced
  languageHint: boolean;
  keyterms: boolean;         // Scribe: repeatable URL param
  vendorVad: boolean;        // false for both in V1 (client commits)
}

export interface SttTransport {
  name: string;
  capabilities: SttCapabilities;
  open(callbacks: SttCallbacks, config: SttSessionConfig): Promise<SttConnection>;
}

export function scribeTransport(options: {
  /** One call = one connect; single-use by construction (aiui-cf-creds/stt or a channel mint route). */
  connectUrl: () => Promise<string>;
  language?: string;
  keyterms?: string[];
}): SttTransport;

export function openaiTranscriptionTransport(options: {
  keySource: KeySource;             // the oracle's seam, reused verbatim
  transcriptionModel?: string;
}): SttTransport;

export function createStt(options: {
  transport: SttTransport;
  audio?: AudioSource;              // absent = caller appends PCM itself
}): SttHandle;                      // appendAudio/commit/discard/drain + callbacks

export function sttSignals(handle: SttHandle): {
  status: Accessor<SttStatus>;
  partial: Accessor<{ segment: number; text: string } | undefined>;
  finals: Accessor<readonly SttFinal[]>;   // text, latencyMs, model, words?
};

// aiui-stt/mic
export function micAudioSource(options?: { deviceId?: string }): AudioSource;
export function MicPicker(props: { onSource(source: AudioSource): void }): JSX.Element;
```

`SttFinal.words` carries the normalized word data (Scribe: timestamps + logprobs;
OpenAI: logprobs via the token→word fold) — the confidence heat map and media-anchor
use cases the turn preview already demonstrates.

## Intent panel adoption — recorded, not required

If the panel ever adopts this component, the shape is: the browser ships **text**
(deltas/finals) to the channel instead of PCM frames; the channel drops one relay hop
and its STT wing, keeps the lowering pipeline unchanged (it composes from
`transcript-final` events either way), and adds a scribe-token mint route next to the
oracle's. One broker/mint round-trip per talk turn. This proposal neither schedules
that nor removes anything from the channel — it only guarantees the seams line up.

## What this package is NOT

- **Not the lowering pipeline.** No correction, no compose, no turn semantics beyond
  segments. Deltas and finals are the whole product.
- **Not the talk lanes.** No modes, no grammar, no capture bus, no barge-in — that is
  the intent runtime's world.
- **Not a viz entry point**, and it adds nothing to aiui-viz (D1, D6).
- **Not a credential custodian.** No keys, no baked hostnames; sources are injected
  (D3). Deployment identity rules follow `aiui-cf-creds.md` D2.
- **Not a vendor SDK wrapper.** Raw WebSocket wire, as the channel does it — the wire
  facts are already ours; a dependency would add weight and hide the parts we
  specifically need to control (FIFO correlation, commit floors, self-commit).

## Open questions

1. **Session lifetime posture for Scribe.** The token is single-use with a 15-minute
   mint-to-connect TTL; the *session's* own ceiling after connect is unverified. V1
   assumption: one connect serves many segments; reconnect mints fresh. Needs an
   empirical check (the ~40 s self-commit behavior is already documented and must be
   handled either way).
2. **Vendor VAD.** Both vendors offer server-side turn detection in some form; V1 is
   client-committed only. Does `vendorVad` become a real capability, and if so, does
   the segment vocabulary survive it?
3. **The token→word fold.** OpenAI's logprob fold lives in the channel
   (`realtime.ts`). Extract to a tiny shared util, or copy? (Copying ~40 lines may
   honestly be cheaper than a package.)
4. **`aiui-stt/mic` promotion.** The oracle's mic needs overlap; promote to a shared
   audio package only when the oracle actually asks, not before.
5. **Naming.** `segment` (the channel's word) vs the pencil's stroke vocabulary.
   Keeping `segment` preserves continuity with the recorded wire facts; deciding at
   implementation review.
