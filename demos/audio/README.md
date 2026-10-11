# Audio routing demo

Run `pnpm -C demos/audio dev`, or choose **Audio** in `pnpm demo`.

One shared audio hub serves ElevenLabs dictation, an Oracle text editor, and the voice dock.
Finish dictation, edit the draft by voice, then return to dictation. Park input to keep the
microphone and sessions connected without sending speech. The meter stays active while parked.
Text changes use the shared `LiveDiffText` renderer.

Credentials use the same saved key fields as other demos, with dev-server environment keys as
fallback. ElevenLabs is required for dictation; OpenAI is required for Oracle editing. Production
hosts can instead configure a credential broker through the toolkit's connect callback.

The model lives in `src/model/store.ts`, the transcript cell and agent actions in `graph.ts`,
and the controls in `src/ui/App.tsx`. The gallery supplies a shared hub through `AudioProvider`;
the standalone entry creates its own durable hub. Leaving the gallery page parks its selected
input while preserving sessions and the draft.

## Real browser smoke

Start the standalone dev server on port 5193, then pass a spoken WAV fixture to:

```sh
node --env-file=../../.env scripts/browser-smoke.mjs /path/to/speech.wav
```

This opens an isolated headless browser, transcribes the file through the actual worklet and
ElevenLabs connection, and (when OPENAI_API_KEY is present) asks Oracle to revise the transcript
and restores dictation while preserving a park. It uses vendor APIs and therefore incurs usage.
Pass an optional second argument (an expected phrase) to assert transcription content.
No physical microphone is needed. Set AUDIO_DEMO_URL to use another standalone dev-server URL.

Checked-in speech recordings and a self-starting STT regression suite are available in
[`aiui-stt`'s testing guide](../../packages/aiui-stt/docs/getting-started.md#repeatable-browser-checks).
That suite measures transcript content and latency, including park/cancel/reconnect behavior;
this demo smoke additionally exercises Oracle editing and restoring dictation.
