# @habemus-papadum/aiui-audio

One browser audio hub shared by dictation, Oracle, and Live. The application owns the hub;
consumers register named endpoints and borrow audio. No vendor credentials or network transport
lives here.

```ts
import { createAudioHub } from "@habemus-papadum/aiui-audio";
import { AudioControl, AudioProvider } from "@habemus-papadum/aiui-audio/widgets";

const audio = createAudioHub();
const dictation = audio.pcmInput({ id: "dictation", label: "Dictation", icon: "✍" });
const editor = audio.streamInput({ id: "editor", label: "Editor", icon: "🔮" });
const replies = audio.output({ id: "editor", label: "Editor", icon: "🔮" });

// In a user gesture. Registering endpoints never requests permission.
await audio.startMicrophone();
await audio.selectInput(dictation.id);
// createStt({ audio: dictation, ... }) enables its subscription per segment.
// webRtcTransport({ input: editor, output: replies, ... }) enables it per connection.

const editing = audio.temporarilyRouteInput(editor.id);
await audio.parkInput();       // meter still works; neither consumer receives speech
await editing.release();      // restores dictation, but preserves the park
await audio.resumeInput();
audio.stopMicrophone();       // releases the device; sessions stay connected
await audio.dispose();        // application teardown
```

## Ownership and routing

Capture, input routing, and playback are independent. There is one input destination at a time.
A selected endpoint receives audio only when enabled by its consumer. Read `selectedInput` for
intent and `activeInput` for the applied route. Endpoint `stop`/`setEnabled(false)` does not
release the microphone. Only the hub stops capture. A temporary route overrides the base;
a newer temporary route supersedes it, and manual selection invalidates its restoration.

Microphone → input bus → meter and AudioWorklet → PCM endpoint. The same bus feeds a gain gate
and stable MediaStream for each WebRTC endpoint. Unselected streams carry silence; their tracks
remain live. Consumers must not stop these tracks. `claimSessionAudio` protects borrowed
endpoints from a stale connection's cleanup. `flush()` fences buffered worklet samples before
an STT commit; route labels travel with samples, so an old frame cannot reach a new consumer.
Park drops audio; it does not record it for later.

Capture defaults to echo cancellation, noise suppression, and automatic gain control. Pass
`constraints` or `deviceId` to `startMicrophone` to override them. `startRecording(samples,
sampleRate, { loop })` replaces the physical microphone with recorded mono audio through the
same graph. Finite recordings stop capture on completion. The default worklet uses a Blob URL;
with a restrictive CSP, serve `AUDIO_WORKLET_SOURCE` as a file and pass `workletUrl`.

Playback has its own selected source, mute, volume, and optional output-device selection.
Blocked autoplay is observable and the control offers an explicit playback gesture. Browser
support determines whether output-device selection is available.

## Widgets

`AudioControl` includes on/off, park/resume, source meter, destination icon and label, device
picker, and playback settings. `AudioMeter`, `AudioRoutePicker`, `MicrophonePicker`, and
`useAudioState` can also be used separately. Wrap a host in `<AudioProvider hub={audio}>` to
share it with `VoiceDock` and nested demos. The provider does not dispose the application hub.

## Browser tests

```sh
pnpm --filter @habemus-papadum/aiui-audio exec playwright install chromium
pnpm --filter @habemus-papadum/aiui-audio test:browser
```

The headless Chromium tests run the real worklet, route a generated recording to PCM and
MediaStream endpoints, verify silence while parked, and exercise the widget with Chrome's fake
microphone. They need neither credentials nor a physical device. Unit tests inject an
`AudioDriver` to cover permission races and routing transitions deterministically.
