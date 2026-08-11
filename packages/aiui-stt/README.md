# @habemus-papadum/aiui-stt

Realtime speech-to-text as a **pencil-shaped component**: start a session, feed it audio, watch a
stream of cumulative text deltas, and know when a segment is final. Contract of record:
`docs/proposals/aiui-stt.md` in the pdum_aiui repo; the wire facts underneath are the aiui
channel's, hard-won against both live vendors and ported verbatim.

**The default engine is ElevenLabs Scribe v2 realtime.** The OpenAI `transcription`-type realtime
flavor is the alternate. Both sit behind one seam, so the vendor difference is confined to the
open.

## Install

```sh
npm install @habemus-papadum/aiui-stt
```

## The shape

```ts
import { createStt, scribeTransport, sttSignals } from "@habemus-papadum/aiui-stt";
import { micAudioSource } from "@habemus-papadum/aiui-stt/mic";
import { scribeConnectUrl } from "@habemus-papadum/aiui-cf-creds/stt"; // or a channel mint route

const stt = createStt({
  transport: scribeTransport({ connectUrl: scribeConnectUrl }), // one call = one connect
  audio: micAudioSource(),
});

// Push-to-talk: the client owns the segment boundary.
button.onpointerdown = () => stt.beginSegment();
button.onpointerup = () => stt.endSegment();

// The Solid face — signals over the handle's event stream.
const { status, partial, finals } = sttSignals(stt);
```

`partial()` is the open segment's **cumulative** text (a partial that gets *shorter* is the vendor
revising itself, not data loss) — exactly what aiui-viz/modal's `LiveDiffText.update()` wants:
appends extend, revisions flash and settle. This package ships no renderer.

## What's deliberately injected

- **Credentials** — never owned here. Scribe takes a `connectUrl()` that mints one single-use
  token per connect (`aiui-cf-creds/stt`'s `scribeConnectUrl` for broker-fronted static apps, or
  a channel mint route). OpenAI takes the oracle's `KeySource` (`transcriptionKeySource`, or any
  chain) — one `ek_` opens multiple sessions until TTL.
- **Audio** — an `AudioSource` of 24 kHz PCM16 frames. `aiui-stt/mic` ships the real microphone
  (getUserMedia → AudioWorklet capture, device picker, level meter); a file player or a test
  script is the same seam. Both engines take the same format, so one capture path serves either.

## The engines' recorded facts (why this port is trustworthy)

- **Scribe** self-commits utterances (~40 s cap) — this engine accumulates them per segment so a
  long dictation never loses text; committing under 300 ms of audio is FATAL on that wire, so a
  local floor refuses it and settles the segment locally; an idle socket dies in ~15 s, so a
  keepalive holds it; word timestamps ride a session-cumulative timeline and are rebased
  per-segment.
- **OpenAI** deltas are incremental and item-correlated (pre-commit deltas bind to the streaming
  segment); token logprobs fold to word confidences (a word's confidence is its WORST token);
  `…transcription.failed` resolves its segment loudly instead of hanging a drain.
- Everything either engine does not understand is **reported** through `onDiagnostic`, never
  silently dropped — the discipline that would have caught the self-commit months earlier.

## What this package is NOT

Not the lowering pipeline (deltas and finals are the whole product), not the talk lanes, not a
credential custodian, not a vendor SDK wrapper — raw WebSocket wire, the parts we specifically
need to control.
