# Share one microphone between sessions

Create one `AudioHub` in the application store. Give it to `AudioProvider`, then register a PCM
endpoint for dictation and stream endpoints for Oracle and Live. Pass those endpoints to the
respective transports; they handle readiness while the hub controls where speech goes.

```tsx
const audio = createAudioHub();
const input = audio.streamInput({ id: "oracle", label: "Oracle", icon: "🔮" });
const output = audio.output({ id: "oracle", label: "Oracle", icon: "🔮" });
const session = new OracleSession({
  keySource: standardKeySources(),
  transport: webRtcTransport({ input, output }),
  config: { instructions: "Help the user with this page." },
});

<AudioProvider hub={audio}>
  <AudioControl hub={audio} />
  <OracleControl session={session} audio={{ hub: audio, input: input.id, output: output.id }} />
  <VoiceDock />
</AudioProvider>
```

`OracleControl`'s explicit connect/resume gesture starts capture if needed and selects its
endpoints. A previously parked hub stays parked until the user resumes input. Hosts with their
own connect button can call `activateSessionAudio` or wire the hub methods directly.

Before switching from dictation to an editor, await `stt.endSegment()` and `stt.drain()` so the
editor sees the final words. Use `temporarilyRouteInput(editor.id)` and release its returned
handle when editing ends. A park or a later manual destination change takes precedence.

See the [package reference](../README.md) for routing semantics, recorded-input tests, and
playback controls, and `demos/audio` for a complete example with a diff display.
