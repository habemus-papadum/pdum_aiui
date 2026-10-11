# Dictation and testing

Start with the [package example](../README.md). The STT audio seam accepts mono, little-endian
PCM16 at 24 kHz. `aiui-audio` resamples microphone or recorded input to that format. The injected
`AudioSource` contract also supports a custom producer, and `appendAudio(bytes)` supports manual
feeding without a source.

For a headless browser test, register the same PCM endpoint used by the application, decode a
recorded speech fixture, and feed it through the hub:

```ts
await audio.selectInput(input.id);
await stt.connect();
stt.beginSegment();
await audio.startRecording(samples, sampleRate);
// Wait for the recording to finish, then:
await stt.endSegment();
const outstanding = await stt.drain(15_000);
```

`startRecording` uses real-time playback through the same Web Audio graph and worklet as a mic.
For a deterministic offline test, inject `SttTransport` or its socket factory and script transcript
events. For an integration test, use a spoken fixture and a credential minter. No Node WebSocket
relay or physical microphone is required. Audio's browser suite separately verifies actual
routing and muted stream tracks using a generated signal and Chrome's fake capture device.

## Repeatable browser checks

From the repo root:

```sh
pnpm -C packages/aiui-stt exec playwright install chromium
pnpm -C packages/aiui-audio test:browser
pnpm -C packages/aiui-stt test:browser
```

Both suites run in CI without vendor keys. STT's suite plays the checked-in
[speech fixtures](../test/fixtures/README.md) through the real audio hub/worklet, PCM resampling,
platform WebSocket, and Scribe adapter. Playwright scripts only the vendor's responses and blocks
external network access. It checks segment completion, audio byte delivery, parking with idle
keepalive, cancellation with a fresh credential, and recovery from a dropped connection with a
pending commit. Audio's four browser tests cover routing, metering, stable stream tracks,
microphone permissions/cleanup, and the final worklet block.

The opt-in live test uses ElevenLabs and incurs API usage. From the repo root:

```sh
cd packages/aiui-stt
node --env-file=../../.env node_modules/@playwright/test/cli.js test --config=playwright.live.config.ts
```

Alternatively, with `ELEVEN_LABS_API_KEY` (or `ELEVENLABS_API_KEY`) already in the environment,
run `pnpm -C packages/aiui-stt test:live`. The test starts its own local server and isolated
headless Chromium. The key stays in the test runner; the injected credential callback mints a
fresh single-use URL for each browser connection. No physical microphone is required.

It asserts both transcripts, waits 16 real seconds while parked to exercise idle keepalive,
then cancels a partial dictation and verifies the next transcript has no cancelled prefix.
Each completed segment reports recording duration, time to first nonempty partial from playback
start, and final latency from the adapter's commit. First partials must arrive before commit;
10-second latency ceilings detect large regressions. The JSON report is printed and attached in
`test-results/`, including completed measurements if a later assertion fails. Traces and videos
are disabled so credential-bearing socket URLs are not recorded.

The two clean English recordings are a small regression check. They do not establish accuracy
across speakers, noise, languages, or long sessions, and timings are single-run observations.
The live suite has a separate config; `test:browser`, bare `playwright test`, and CI are offline.

Use `onDiagnostic`/`subscribe` for config echoes, mismatches, vendor commits, orphan results, and
unknown protocol events. Avoid logging credential-bearing WebSocket URLs.
