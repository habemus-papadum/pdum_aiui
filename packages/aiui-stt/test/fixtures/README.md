# Speech fixtures

These are synthetic recordings of original test sentences, generated locally with macOS `say`
(Samantha, 175 words/minute), then converted with `afconvert`. No user recordings or API keys
are involved. Both files are mono, 24 kHz, little-endian PCM16 WAVs; together they are about
400 KB. Check them in so Linux CI and live evaluations play the same audio without TTS access.

- `garden.wav` (6.15 seconds): “The red balloon floats above the quiet garden. We are testing
  speech recognition in the browser with a recorded voice.”
- `harbor.wav` (2.06 seconds): “Seven blue boats are waiting in the harbor.”

To regenerate on macOS, from this directory:

```sh
say -v Samantha -r 175 -o /tmp/aiui-stt-garden.aiff 'The red balloon floats above the quiet garden. We are testing speech recognition in the browser with a recorded voice.'
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/aiui-stt-garden.aiff garden.wav
say -v Samantha -r 175 -o /tmp/aiui-stt-harbor.aiff 'Seven blue boats are waiting in the harbor.'
afconvert -f WAVE -d LEI16@24000 -c 1 /tmp/aiui-stt-harbor.aiff harbor.wav
```

Expected text lives in `../browser/helpers.ts`. Live assertions ignore case, punctuation, and
whitespace. These two clean English clips are regression fixtures, not an accuracy benchmark
for accents, noise, languages, or long dictation. OS voice updates can change regenerated audio.
