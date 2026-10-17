# @habemus-papadum/aiui-stt

Browser speech-to-text with ElevenLabs Scribe. Explicit dictation segments produce cumulative
partial text and final transcripts. Audio capture and controls live in
[`aiui-audio`](../aiui-audio/README.md); transcription opens a WebSocket directly to ElevenLabs.
There is no Node audio relay and no OpenAI STT adapter.

```ts
import { createAudioHub } from "@habemus-papadum/aiui-audio";
import { createStt, scribeTransport, sttSignals } from "@habemus-papadum/aiui-stt";
import { standardScribeConnectUrl } from "@habemus-papadum/aiui-cf-creds/stt";

const audio = createAudioHub();
const input = audio.pcmInput({ id: "dictation", label: "Dictation", icon: "✍" });
const stt = createStt({
  audio: input,
  transport: scribeTransport({ connectUrl: () => standardScribeConnectUrl() }),
});
const transcript = sttSignals(stt);

// User gesture:
await audio.startMicrophone();
await audio.selectInput(input.id);
await stt.connect();
stt.beginSegment();
// Later, finish speaking:
await stt.endSegment();       // fences the buffered audio tail before committing
const outstanding = await stt.drain(); // [] means all committed segments settled
```

`beginSegment()` also connects automatically and queues frames through credential minting.
Await `endSegment()` before beginning the next segment. `drain(timeoutMs)` reports outstanding
segment IDs on timeout; errors arrive through callbacks/events. Remote connection failure moves
the handle to `error`, stops its subscription, and allows a fresh `connect()`. `close()` invalidates
pending connects and releases the subscription without stopping the shared microphone.

Credentials remain an injected `connectUrl(): Promise<string>`. Every connection needs a fresh
single-use token. `standardScribeConnectUrl` resolves an explicit API-key callback, otherwise the
shared pasted/dev key, then an explicitly configured broker. `scribeConnectUrl` always uses a
credential broker, including a same-origin route. Any custom credential minter can supply the URL.
Keys and tokens do not belong in the audio hub.

`sttSignals(stt)` exposes status, cumulative partial text, final segments, and errors. Feed text
into `LiveDiffText` from `aiui-viz/live-text` for appended words and visible revisions. That renderer
remains shared; it is not tied to transcription. The gallery's **Audio** demo combines dictation,
Oracle editing, routing controls, credential fields, and the diff display.

Scribe self-committed utterances are accumulated into the client segment. Short nonempty segments
are padded with silence to the safe commit floor; empty ones settle locally. Cancellation closes
the Scribe connection because the protocol has no clear-buffer operation, preventing cancelled
audio from becoming the next segment's prefix. The next segment reconnects. Parking the audio
hub keeps the session open, with an idle keepalive. Word timestamps are rebased per segment.

Run `pnpm -C packages/aiui-stt test:browser` for offline browser regression tests (also in CI).
The opt-in `test:live` suite checks recorded speech against ElevenLabs and reports partial/final
latency. See [getting started](docs/getting-started.md#repeatable-browser-checks) for setup,
fixtures, and the evaluation's scope.
