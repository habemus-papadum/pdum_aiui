# Getting Started with @habemus-papadum/aiui-stt

Realtime STT with the pencil's contract: segments in, cumulative deltas + finals out.

## Pick an engine

| | `scribeTransport` (DEFAULT) | `openaiTranscriptionTransport` |
| --- | --- | --- |
| Vendor | ElevenLabs Scribe v2 realtime | OpenAI realtime, `transcription` sessions |
| Credential | single-use token per connect (`connectUrl()`) | `ek_` via the oracle's `KeySource` |
| Word timestamps | yes (segment-rebased) | no (wire has none) |
| Word confidence | yes (logprobs) | yes (token→word fold) |
| Language hint / keyterms | yes / yes | no / no |

Both engines: 24 kHz PCM16 in, client-committed segments (push-to-talk), `vendorVad: false` in V1.

## Wire it

```ts
import { createStt, scribeTransport, sttSignals } from "@habemus-papadum/aiui-stt";
import { micAudioSource, MicPicker } from "@habemus-papadum/aiui-stt/mic";

const stt = createStt({
  transport: scribeTransport({
    connectUrl: () => fetch("/my/mint/route").then((r) => r.text()), // your credential seam
    keyterms: ["morphogen", "aiui"],
  }),
  audio: micAudioSource(),
});

stt.connect();                       // eager: overlap the mint with the arm→talk gap
const seg = stt.beginSegment();      // key down
stt.endSegment();                    // key up → the segment's final arrives via events
await stt.drain();                   // before composing: wait for in-flight finals
```

`beginSegment` auto-connects and the handle queues ops through the mint window, so "hold the key
and talk immediately" loses nothing even without the eager `connect()`.

## Observe it

`sttSignals(stt)` gives Solid signals: `status`, `partial` (the open segment's cumulative text),
`finals` (append-only, with per-word data when the engine has it), `lastError`. Feed `partial`
into aiui-viz/modal's `LiveDiffText` for the streaming-text look. For anything deeper, subscribe
to the raw event stream (`stt.subscribe`), which includes `diagnostic` events — config echoes,
vendor self-commits, unhandled message types.
