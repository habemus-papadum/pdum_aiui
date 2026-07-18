# Handoff: OpenAI model tiers (cost-sized presets over the intent pipeline)

> **STATUS — T1–T3 LANDED 2026-07-05.** The dial (T1), premium TTS acks (T2), and the flagship
> conversational voice session (T3) are built and shipped; T4 (flagship page-tools bridge) remains
> the gated follow-up. See the per-phase "landed" annotations in [Phasing](#phasing-each-lands-independently)
> and the [divergences from this spec](#divergences-found-in-implementation-landed-2026-07-05) below —
> the spec held up, with a handful of small corrections (the flagship endpoint wants the model as a
> URL query param; the reply audio is WAV-wrapped; the `speech` message fields are `id`/`data`/`label`).
> It sits downstream of `streaming-turns.md` (S1–S3 landed; S4 audio-back landed as T2 here) and
> promotes the L2/L3 rungs of `workbench/docs/openai-audio-stack.md` from "spike later" to shipped.
> It **extends** the existing fine-grained `IntentPipelineConfig`: a new `tier` field is a **preset**
> that expands into the fine fields already on the config; explicit fine fields still win, and the
> advanced panel and `aiui_overlay set_config` keep full granularity. The default tier reproduces the
> current REST-mini pipeline exactly. From the aiui-main session.

## The goal, in one paragraph

Today the pipeline has a dozen model knobs (`transcriber`, `model`, `realtimeModel`,
`realtimeDelay`, `corrector`, `correctionModel`, …) and no shorthand: to move up from cheap REST
transcription to the faster realtime path you set three fields correctly, and the audio-native
experiences the audio-stack doc sketched (spoken acks, a full talk-back voice model) have no
config surface at all because they have no backend yet. This doc gives the whole ladder a single
dial. A `tier` picks a **cost-sized preset** — `mock` for offline dev, then four paid rungs from
"cheap REST, a beat behind" up to "a GPT-5-class voice model that answers aloud, lets you interrupt
it, and can call tools" — and the preset expands into the same fine fields the lowering already
reads, so the channel, the trace, the gear panel, and the agent's `set_config` all inherit it for
free. Part 1 inventories every model-backed seam we have and what's been measured on it; Part 2 is
the verified July-2026 OpenAI catalog and prices the tiers are built from; Part 3 is the tier
design — the expansion table, the premium/flagship session mechanics the implementer needs, the
loud-degradation rules, the per-tier tests, and the phasing.

---

# Part 1 · Inventory — every model-backed seam today

Read at a glance: what is wired, what is the shipped default, what has real measured numbers, and
what is designed-but-not-built. Latency numbers are from the lab (`bench/transcribe-bench.ts`,
`say`-synthesized speech, 2026-07) and the `streaming-turns.md` S3/T6 measurements; treat WER as a
floor (synthesized speech is easy audio).

| Seam | Where | Model(s) | Status | Measured | Notes |
| --- | --- | --- | --- | --- | --- |
| **REST STT (default)** | `channel/transcribe.ts:100` `openaiTranscriber`; default `config.ts:109` | **`gpt-4o-mini-transcribe`** | **wired · shipped default** | ~1406 ms @1.9 s audio; RTF 0.75→0.03 as length grows; median release→final **1427 ms** (S3) | `/v1/audio/transcriptions`, one POST per PTT segment, no partials. Filename-extension sniff is load-bearing (`audioExtensionForMime`). |
| REST STT (accuracy) | same seam, `model` override | `gpt-4o-transcribe` | wired (override) | 755 ms @7.5 s audio, WER 0.0 | Higher accuracy, same ~$/latency class as whisper-1. A `model` override inside the floor tier, not its own rung. |
| REST STT (legacy) | same seam, `model` override | `whisper-1` | wired (override) | **8317 ms @45 s** (scales with duration) | Latency grows with clip length; **dominated** by `gpt-4o-mini-transcribe` on both cost and latency. Compat/robustness fallback only — see the cheap-band note in Part 3. |
| **Realtime STT** | `channel/realtime.ts:153` `openRealtimeSession`; opt-in `transcriber:"openai-realtime"` | **`gpt-realtime-whisper`** (`DEFAULT_REALTIME_MODEL` `realtime.ts:46`) | **wired · opt-in (S2)** | release→final **655 ms** median (655/614/692), **~2.2× faster than REST**; **0 partials before commit** (T6) | GA WS `wss://…/v1/realtime?intent=transcription`, PCM16/24 kHz, `turn_detection:null` (PTT commits), `delay` knob (`minimal…xhigh`). Faster *final*, **no** live-preview-while-talking. |
| **Correction diff** | `channel/correct.ts:103` `openaiCorrector`; default `config.ts:114` | **`gpt-4o-mini`** (temp 0, V4A patch) | **wired · shipped default** | **~2.1–2.3 s** per correction | Selection + instruction → `apply_patch` diff. `SYSTEM_PROMPT` (`correct.ts:67`) is load-bearing (REPLACEMENT vs DESCRIPTION modes). Pre-warmed on arrival (streaming-turns §2). |
| Mock STT / corrector | `transcribe.ts:76`, `correct.ts:45` | `mock` | wired · offline dev | n/a | No key, no network, deterministic. The workbench lab default; the explicit offline choice, never a silent fallback. |
| **TTS acks** | *designed* — `channel/speak.ts` (streaming-turns §4, S4) | `gpt-4o-mini-tts` | **designed · not built** | — | `POST /v1/audio/speech`, base64 `speech` server message → page player. Short spoken confirmations ("sent"). Surface verified, code not landed. |
| **Conversational realtime** | *designed here* — new `channel/realtime-voice.ts` | `gpt-realtime-2` (family) | **designed · not built** | — | audio-stack L2/L3. Spoken answers + barge-in + model turn detection + function calling. This doc is its spec. |

**Live coverage that exercises the wired seams** (capped-key, weekly `openai-e2e.yml`,
`describe.skipIf(!OPENAI_API_KEY)`, near-zero tokens):

- `packages/aiui/test/openai-pipeline.e2e.ts` — REST transcription shape (200 + non-empty text) and
  the correction diff (a returned V4A patch that parses and applies). Models: `gpt-4o-mini-transcribe`,
  `gpt-4o-mini`.
- `packages/aiui/test/openai-realtime.e2e.ts` — one ~2 s realtime session through the production
  `openRealtimeSession`: ≥1 delta, non-empty final, latency recorded. Model: `gpt-realtime-whisper`.
- `bench/transcribe-bench.ts` — the lab: REST leg (latency/RTF/WER across models) + a realtime leg
  (`--realtime=`, deltas-before-release + release→final side by side with REST). This is where a new
  model's numbers get measured before it graduates.

**Not measured anywhere yet:** any TTS path, any conversational realtime model, and — the load-bearing
gap — whether *any* OpenAI STT streams true partials **while you are still speaking** under our
PTT+manual-commit shape (Part 2 and the honest-unknowns).

---

# Part 2 · Researched catalog + pricing (verified July 2026)

Prices read from `developers.openai.com/api/docs/pricing` and the per-model pages, July 2026. Audio
is billed **per audio token** for the conversational models and **per minute** for the transcription
models; the token models convert at OpenAI's stated rate of **1 token / 100 ms of user audio**
(≈600 tok/min in) and **1 token / 50 ms of model audio** (≈1200 tok/min out).

| Model | Role | Price (July 2026) | Latency / liveness | In repo |
| --- | --- | --- | --- | --- |
| `gpt-4o-mini-transcribe` | REST STT | $1.25/M text-in · $5/M out · $3/M audio-in ≈ **$0.003/min** | ~1.4 s final, no partials | **default** |
| `gpt-4o-transcribe` | REST STT | $2.50/M · $10/M · $6/M audio-in ≈ **$0.006/min** | ~0.8 s final, no partials | override |
| `whisper-1` | REST STT (legacy) | **$0.006/min** | scales with duration (8.3 s @45 s) | override |
| `gpt-realtime-whisper` | Realtime STT (streaming) | **$0.017/min** | **655 ms** final; **0 partials before commit** (measured) | opt-in (S2) |
| `gpt-realtime-translate` | Realtime translate | $0.034/min | streaming | — (not for us) |
| `gpt-4o-mini-tts` | REST TTS | $0.60/M text-in · $12/M audio-out ≈ **$0.015/min** | chunked streaming; 11 voices | designed (S4) |
| `gpt-4o-mini` | Text (correction diff) | $0.15/M in · $0.60/M out | ~2.2 s per diff | **default** |
| `gpt-4o-mini-realtime-preview` | Realtime S2S (budget) | audio **$10/M in · $20/M out** · $0.30/M cached; text $0.60/M · $2.40/M | conversational, barge-in, tools | designed (flagship override) |
| `gpt-realtime` | Realtime S2S (GA base) | audio **$32/M in · $64/M out** · $0.40/M cached | conversational, barge-in, tools | designed (flagship override) |
| **`gpt-realtime-2`** | **Realtime S2S (flagship)** | audio **$32/M in · $64/M out** · $0.40 cached; text **$4/M · $24/M** · $0.40 cached; image **$5/M in** · $0.50 cached | GPT-5-class reasoning, 128k ctx, configurable reasoning effort, tools, **image-in** | **designed (flagship default)** |

**Corrections to the repo's forward-dated names.** The audio-stack doc (2026-07, written before the
May-2026 voice launch) used placeholder ids that have since been superseded:

- Its L2 `gpt-audio-1.5` and L3 `gpt-realtime-2` were forward-dated guesses. As of the **May 8 2026
  GA voice launch**, the real family is **`gpt-realtime`** (base speech-to-speech), **`gpt-realtime-2`**
  (the flagship reasoning voice model — *the user's named model is real and current*),
  **`gpt-realtime-translate`**, and **`gpt-realtime-whisper`** (streaming STT). The Realtime API left
  beta at the same launch — hence the S2 drift `streaming-turns.md` already recorded (the Beta shape
  is disabled; the channel speaks the GA shape). So the audio-stack's L2 "audio-native chat model" is
  now just a modality choice on the same `gpt-realtime*` conversational models — there is no separate
  `gpt-audio` product to wire.
- The audio-stack's L3 cost sketch ("audio input ≈ $0.02/min") checks out: 600 tok/min × $32/M =
  **$0.019/min heard**; model speech is **$0.077/min spoken** (1200 tok/min × $64/M). Its `gpt-realtime-2`
  text/image prices ($4/$24 text, $5 image) are confirmed exactly.

**The liveness gap (the most consequential research finding).** "Partials that fill the preview
*while you are still talking*" is the one thing none of OpenAI's STT paths reliably deliver for our
PTT+manual-commit shape: `gpt-realtime-whisper` transcribes the *committed* buffer, so we measured
**0 partials before release** (S3/T6); and community reports for `gpt-4o-transcribe` in a realtime
session say its `…transcription.delta` events **arrive batched at end-of-turn**, not incrementally.
True while-speaking liveness would need server-VAD chunking (not manual commit) and a model that
emits interim results — untested by us. **So the realtime STT tier graduates on *latency* (a clear,
measured 2.2× win on the final), not on *liveness*.** The richer "it responds while you talk" feel
comes only from the conversational flagship — a *spoken* response, a different thing than a filling
text preview.

**Non-OpenAI alternatives (one paragraph, noted not designed-for).** Deepgram (Nova streaming STT
over WebSocket with true sub-300 ms interim results, plus Aura TTS) remains the strongest *liveness*
competitor and would be the first place to look if the lab's histograms say OpenAI can't fill the
preview live; AssemblyAI, Gladia, and Soniox also offer streaming STT with interim results. All fit
behind the same `Transcriber` / session seams — a vendor swap is a new implementation, not an
architecture change — so a future `tier` could name a non-OpenAI backend without touching the wire.

---

# Part 3 · The tier design

## Labels and cost anchors

The dial is `tier`, a preset over the fine config. Five values — `mock` (offline, keyless, $0) plus
four paid rungs. Names ascend in cost and richness; each is tagged with a **$/active-hour** estimate
under a ~10 min-of-speech-per-active-hour duty cycle (a heavy dictation session; light use is a
fraction), plus corrections.

| `tier` | What it is | Backend | $/active-hr (~10 min speech) | What you feel |
| --- | --- | --- | --- | --- |
| `mock` | offline dev | mock STT + mock corrector | **$0** | canned transcript; no key, no network. |
| **`standard`** *(default)* | cheap REST, a beat behind | `gpt-4o-mini-transcribe` + `gpt-4o-mini` | **~$0.03** (¢) | dictate, it catches up ~1.4 s later. Today's behavior, unchanged. |
| **`rapid`** | the wait disappears | `gpt-realtime-whisper` + `gpt-4o-mini` | **~$0.17** (dimes) | same silence, the final snaps in ~2× faster (655 ms). No partials, no voice back. |
| **`premium`** | eyes-free confirmations | `rapid` + `gpt-4o-mini-tts` acks | **~$0.18** (dimes) | it says "sent" / "got it" back to you; keep looking at the app, not the preview. |
| **`flagship`** | a voice model that talks back | `gpt-realtime-2` (audio+text, tools) | **~$1–6** (dollars) | spoken answers, barge-in, model turn-detection, function calling. Text still the source of truth. |

Why these names: they ascend obviously and reuse the user's own vocabulary ("standard" / "premium"),
and "flagship" is literally OpenAI's word for `gpt-realtime-2`. `rapid` names the *one* thing that
rung changes (speed, not modality). Note `rapid`→`premium` is a **feature** step (voice back for a
few extra pennies of TTS), not really a cost step — the dollars only appear at `flagship`. *Alternative
if you prefer pure cost names: `penny`/`nickel`/`dime`/`dollar` — more cost-honest, but they don't
convey the richness the way `premium`/`flagship` do, and the middle two are both "dimes," so the coin
ladder mis-separates them. Recommend the richness names; the table's $/hr column carries the cost
honesty. This is a one-line veto in Open Decisions.*

**The cheap-band question the user raised ("a whisper tier and a GPT tier").** The intuition that
`whisper-1` is the cost floor is **out of date**: `gpt-4o-mini-transcribe` is *both* cheaper
($0.003 vs $0.006/min) *and* faster (flat ~1.4 s vs whisper's duration-scaling 8.3 s @45 s). So the
floor is the GPT-mini tier (`standard`), and `whisper-1` survives only as a `model` **override** — a
different acoustic model that is occasionally more robust on hard audio, and a vendor-diversity
fallback — not a recommended rung. `gpt-4o-transcribe` is likewise a `model` override inside
`standard` for a WER bump at the same cost/latency class. Keeping these as overrides rather than
rungs is the honest structure: they don't change the *experience* enough to name.

## The expansion table (the preset → fine fields)

Each tier is a `Partial<IntentPipelineConfig>` in a new `TIER_PRESETS` map next to
`DEFAULT_INTENT_CONFIG` (`config.ts`). New fine fields (below) carry the audio-back and conversational
knobs the current config lacks. Blank = "not set by this preset" (inherits `DEFAULT`).

| Fine field | `mock` | `standard` | `rapid` | `premium` | `flagship` |
| --- | --- | --- | --- | --- | --- |
| `transcriber` | `mock` | `openai` | `openai-realtime` | `openai-realtime` | `openai-voice`¹ |
| `model` | — | `gpt-4o-mini-transcribe` | — | — | — |
| `realtimeModel` | — | — | `gpt-realtime-whisper` | `gpt-realtime-whisper` | — |
| `corrector` | `mock` | `openai` | `openai` | `openai` | `openai` |
| `correctionModel` | — | `gpt-4o-mini` | `gpt-4o-mini` | `gpt-4o-mini` | `gpt-4o-mini` |
| `audioBack` *(new)* | `off` | `off` | `off` | `acks` | `voice` |
| `ttsModel` *(new)* | — | — | — | `gpt-4o-mini-tts` | — |
| `realtimeVoiceModel` *(new)* | — | — | — | — | `gpt-realtime-2` |
| `realtimeVoice` *(new)* | — | — | — | — | `cedar` |
| `realtimeTools` *(new)* | — | — | — | — | `none`² |

¹ `flagship` needs a new `transcriber` value **`"openai-voice"`** — the conversational session is a
different shape than the STT session (it returns audio + a tool surface, not just text), so it is a
fourth value on the same seam-selector, exactly as `"openai-realtime"` was a third (streaming-turns
Open Decision #2). ² Function-calling scope; `none` for v1 (see below).

New fields, added to `IntentPipelineConfig` (`config.ts`) with docs:

```ts
/** Spoken audio back to the human. off = silent; acks = short TTS confirmations
 *  (premium); voice = native conversational speech from the realtime model (flagship). */
audioBack: "off" | "acks" | "voice";
/** REST TTS model for `audioBack:"acks"`. Absent → gpt-4o-mini-tts. */
ttsModel?: string;
/** TTS voice id (acks). Absent → the model default. */
ttsVoice?: string;
/** Conversational realtime model for `audioBack:"voice"`. Absent → gpt-realtime-2.
 *  Budget alternatives: gpt-realtime, gpt-4o-mini-realtime-preview. */
realtimeVoiceModel?: string;
/** Conversational voice id (flagship). Absent → the model default (e.g. cedar/marin). */
realtimeVoice?: string;
/** Function-calling scope for flagship. none = no tools; submit_intent = one IR tool;
 *  page = the curated page-tools bridge (v2). Absent → none. */
realtimeTools?: "none" | "submit_intent" | "page";
/** Reasoning effort for gpt-realtime-2 (flagship). Absent → the model default. */
realtimeReasoning?: "minimal" | "low" | "medium" | "high";
```

And the dial itself:

```ts
/** Cost-sized preset that expands into the fine fields; explicit fine fields win.
 *  Absent → "standard" (reproduces today's REST-mini default exactly). */
tier?: "mock" | "standard" | "rapid" | "premium" | "flagship";
```

## Expansion semantics — the one piece of real new code

The precedence is **`DEFAULT` ← `expand(tier)` ← explicit fine fields (Vite `intent` ∪ panel/agent
overrides)`**. The preset fills fine fields *above* the defaults but *below* anything a human or
agent set explicitly. The subtlety: once layers are merged, every field has a value, so you cannot
tell "user set `model`" from "`DEFAULT` provided `model`". The fix is to expand at the **delta**
level, not the merged level. Revise `effectiveConfig` (`advanced-config.ts:154`) to:

```ts
export function effectiveConfig(viteOption, overrides): IntentPipelineConfig {
  const explicit = { ...viteOption, ...overrides };            // the non-default layers = "set on purpose"
  const tier = explicit.tier ?? DEFAULT_INTENT_CONFIG.tier ?? "standard";
  const preset = TIER_PRESETS[tier] ?? {};
  return { ...DEFAULT_INTENT_CONFIG, ...preset, ...explicit };  // preset below explicit
}
```

This gives exactly "explicit fine fields override the preset": `set_config({ tier:"flagship",
model:"whisper-1" })` runs the flagship voice model but with `model` pinned to whisper-1 for whatever
reads it. It needs the **raw explicit deltas**, not the already-merged `base` — so the modality must
thread the raw Vite `intent` partial (it has it at `vite.ts:94`) alongside the panel overrides, rather
than passing a pre-merged `base`. That is the single bit of plumbing that is not literally free.

**The tier-switch delta trap (spec this precisely for the implementer).** The advanced panel's JSON
editor shows the *fully expanded* effective config, and `computeOverrides` (`advanced-config.ts:136`)
captures "keys that differ from base". If a user switches `tier: "flagship" → "standard"` while the
editor still literally contains flagship's `realtimeModel`/`audioBack` values, those now differ from
the standard base and get frozen as explicit overrides — pinning flagship fields onto standard. Fix:
when the applied delta contains a changed `tier`, **strip every tier-controlled fine field from the
delta unless it differs from the *new* tier's preset** (compare against `TIER_PRESETS[newTier]`, not
against `base`). Put this in the apply path (`applyConfigFromAgent`, `modality.ts:750`, and the
panel's Apply) so both the gear and the agent behave identically. Equivalent user-facing rule:
*changing `tier` re-derives the fields that tier owns; only fields you set after the switch stick.*

**Channel side.** The client sends the fully-expanded effective config on the hello (`modality.ts:244`
`openThread({ intent: config })`), so `resolveIntent` (`intent-v1.ts:133`) already sees concrete fine
fields and needs only to (a) read the new fields (`audioBack`, `ttsModel`, `realtimeVoiceModel`,
`realtimeVoice`, `realtimeTools`, `realtimeReasoning`) with the same `str`/`oneOf` guards, and (b)
call the shared `expandTier` as a **defensive fallback** for a hello that carries only `tier` (the
channel already imports from `@habemus-papadum/aiui-dev-overlay/intent-pipeline`, so `TIER_PRESETS`/
`expandTier` are importable — keep the expansion in `config.ts` so both sides use one source of truth).

## What the config surface inherits for free — confirmed

Because `tier` is just a field on `IntentPipelineConfig`, it rides every surface that already carries
the config, with only the schema needing a hand-edit:

- **Vite `intent` option** (`vite.ts:94`, `Partial<IntentPipelineConfig>`) — an app writes
  `aiuiDevOverlay({ intent: { tier: "premium" } })`. Free.
- **Gear / advanced panel** — the JSON editor already renders the full effective config; `tier` and
  the new fine fields appear once they are in the type. **Not free:** the strict validator's `SCHEMA`
  (`advanced-config.ts:78`) must gain `tier: oneOf([...])` plus the new fine fields, or the panel
  rejects them as unknown keys.
- **`aiui_overlay set_config`** (`overlay-tools.ts:132`) — uses the *same* validator, so
  `{ config: { tier: "flagship" } }` works the moment `SCHEMA` knows `tier`. Free after the schema
  edit. `report()`/`get_config` return the effective config, so the resolved tier + expanded fields
  are visible to the agent.
- **The trace** — `intent-v1.ts:283` already records the resolved config; add `tier` and the new
  fields to that `info` record so a lowering run shows which tier produced it.

## Premium (`flagship`) mechanics — what the implementer needs

The flagship session is the real new backend. It is `gpt-realtime-2` over the GA realtime WebSocket
(same endpoint family as the STT session, without `?intent=transcription`). The design **reuses the
existing STT lowering for the prompt** and adds voice as a layer on top — so it degrades gracefully
and the trace stays honest.

**Session shape** (`session.update`, GA nested form, verified July 2026):

```jsonc
{ "type": "session.update", "session": {
  "type": "realtime",
  "model": "gpt-realtime-2",
  "instructions": "<the ack/answer persona — short; billed as input tokens every turn>",
  "output_modalities": ["audio"],              // audio out; text transcript comes free (below)
  "audio": {
    "input":  { "format": { "type": "audio/pcm", "rate": 24000 },
                "transcription": { "model": "gpt-4o-mini-transcribe" },   // user transcript → the IR
                "turn_detection": null },        // PTT is the boundary (Q1: keep the gesture)
    "output": { "format": { "type": "audio/pcm", "rate": 24000 }, "voice": "cedar" } },
  "tools": []                                    // v1: none (or one submit_intent — below)
} }
```

**Two transcripts, both captured.** Input transcription stays ON, so
`conversation.item.input_audio_transcription.completed` gives the **user's** transcript — this feeds
`composeIntent` exactly as in `standard`/`rapid`, so the lowered prompt (the IR) never depends on the
voice model choosing to emit anything. The model's spoken output arrives as
`response.output_audio_transcript.delta` / `.done` — the transcript of what it *said* — which we log
to the trace so the IR records what the human was told (the audio-stack Q5 "no divergence"
invariant). Text remains the single source of truth.

**Audio to the page.** Output audio streams as `response.output_audio.delta` (base64 PCM). For v1,
**buffer the deltas server-side per response and push one base64 `speech` message** — the exact
additive server message `streaming-turns.md §4` designed for TTS acks (`{ kind:"speech", threadId,
mime, audioBase64 }`), decoded and played by the same modality player. Acks and one-liners are small,
so one message per response is fine and keeps the back-channel additive. **Follow-up:** if spoken
*answers* grow past a sentence or two, promote to streamed base64 chunks (or the binary back-channel
`streaming-turns.md` flagged) so playback starts before the response finishes — noted, not built.

**PTT coexists with model turn detection.** With `turn_detection: null`, the human's PTT gesture
drives the turn: `talk-end` → `input_audio_buffer.commit` → `response.create` ("your turn now").
Model-side VAD stays off in v1 (PTT is the contract, audio-stack Q1). **Barge-in:** on `talk-start`
while a response is playing, send `response.cancel` and stop local playback; rely on `getUserMedia`
echo cancellation and keep spoken output short to shrink the collision window (same posture as the
TTS ack barge-in in `streaming-turns.md §4`). Dropping PTT for model VAD is a later experiment
(streaming-turns S5), gated on dogfooding.

**Function-calling scope — minimal v1, the bridge is v2.** Function calls arrive as
`response.function_call_arguments.delta` / `.done` (a `conversation.item` of type `function_call`);
results go back via `conversation.item.create` with a `function_call_output`. Scope it deliberately:

- **v1 (`realtimeTools: "none"`, default):** zero tools. Flagship is "`rapid` + a voice that answers
  and can be interrupted." The user transcript is still the IR; the model just talks. Nothing the
  model does is irreversible or reaches the page. This is the "start playing" rung.
- **v1.5 (`realtimeTools: "submit_intent"`, opt-in):** one tool, `submit_intent{ body, meta }` — the
  audio-stack L3 reconciliation, where the **tool-call schema *is* the IR** and the trace records it.
  Off by default: it lets the model *shape* the lowered intent, an experiment worth measuring against
  the transcript-driven compose, without ever giving up the trace.
- **v2 (`realtimeTools: "page"`, later):** expose a **curated subset** of the page-tools directory
  (`window.__AIUI__.tools`, via `page_tools_list`/`page_tools_call`) plus the `aiui_overlay` namespace
  to the model, so a voice model can actually *drive the app*. This is powerful and raises the trust
  questions the security posture is built around: a voice model issuing tool calls directly, inside a
  `--dangerously-skip-permissions` session, from ambient audio. Design it behind an explicit allowlist
  and a confirmation surface; flagged here as a follow-up with its own review, not this wave.

## Preflight / degradation — loud, never a silent downgrade

Per project posture (the existing keyless path degrades *loudly*, never silently to `mock`) and the
"never silently downgrade a tier" rule, each rung fails visibly when its backend is unavailable:

- `standard` keyless → no transcript, surfaced in the preview/trace (today's REST-keyless behavior,
  `intent-v1.ts:258`).
- `rapid` keyless → the realtime session is absent, the segment finalizes loudly (today's
  `realtimeReady === false` path, `intent-v1.ts:279`).
- `premium` keyless → **both** STT and TTS unavailable; loud. Key present but the TTS/speech call
  fails → surface the error, do **not** silently become `rapid`. (Audio-back is a promised feature of
  the tier; its silent absence would be a silent downgrade.)
- `flagship` keyless → the `gpt-realtime-2` session cannot open → a **loud** "flagship needs
  OPENAI_API_KEY" in the preview + trace; **never** a silent fall back to REST. Same as the realtime
  posture today.

Add a per-tier **preflight** at thread-open: resolve the tier, check the key/seam its preset needs,
and if unavailable record a loud `info`/`error` in the trace and show it in the panel footer — the
turn still runs (so the human sees *something*), but it runs the *degraded-loud* path, not a quietly
cheaper tier. The gear panel's status line and `report().status` are the surfaces for this.

## Testing per tier

- **Bench (`bench/transcribe-bench.ts`).** The STT tiers are covered by the existing REST leg
  (`standard`) and realtime leg (`rapid`, `--realtime=gpt-realtime-whisper`). Extend the `--realtime=`
  list to sweep candidate STT models (e.g. add `gpt-4o-transcribe` to *measure* the batched-vs-streaming
  partials question — the liveness gap). Add a **conversational leg** for `flagship`: open a
  `gpt-realtime-2` session, send one `say` utterance + `response.create`, and report **time-to-first-
  audio-out**, **time-to-first-output-transcript**, and estimated $/turn (audio-in + audio-out +
  instruction tokens). Different shape than STT, so it prints its own table.
- **Capped-key e2e (weekly `openai-e2e.yml`, one cheap call per tier family).** REST transcribe +
  correction exist; realtime STT exists. Add: (a) a **TTS smoke** for `premium` — `POST /v1/audio/speech`
  one short string, assert 200 + non-empty audio + content-type (deferred with S4 in streaming-turns);
  (b) a **flagship smoke** — open a `gpt-realtime-2` session, stream a short PCM utterance + `response.create`,
  assert ≥1 `response.output_audio.delta`, a non-empty `response.output_audio_transcript.done`, a
  non-empty input transcript, and a clean close. Shape only, never quality; fractions of a cent.
- **Human with a mic (the irreducible remainder).** Extend the `streaming-turns.md §5` dogfood
  checklist: does the `premium` spoken "sent" beat the visual toast? does `flagship` barge-in duck
  cleanly with no echo into the mic? is the conversational round-trip fast enough to feel like a
  reply, not a wait? These are the felt qualities only a person can rank, run behind the `tier` toggle.

## Phasing (each lands independently)

- **T1 — the dial, over existing backends. → landed 2026-07-05.** `tier` field + `TIER_PRESETS` +
  `expandTier` + `TIER_CONTROLLED_KEYS` (`config.ts`); the revised `effectiveConfig` + the tier-switch
  delta reconciliation `overridesForApply` + `SCHEMA` entries (`advanced-config.ts`); the raw-vite-partial
  threading + `usesPcmStream` (`modality.ts`); the `resolveIntent` new fields + `expandTier` defensive
  fallback + trace fields (`intent-v1.ts`). `mock`/`standard`/`rapid` work end-to-end immediately;
  `premium`/`flagship` were selectable-but-loud-degrade until T2/T3. No wire change, no new deps.
- **T2 — `premium` (audio-back acks). → landed 2026-07-05.** This *is* `streaming-turns.md` S4:
  `channel/speak.ts` (`gpt-4o-mini-tts`, injectable fetch), the base64 `speech` server message
  (`SpeechMessage`), the modality `SpeechPlayer` (`multimodal/speech.ts`) + `talk-start` duck. One
  send-received ack (`ACK_PHRASES`, data-driven) on a successful `fin`. Additive server message kind;
  no wire break. Live: a spoken "sent" synthesizes in ~1.1 s (~14 KB).
- **T3 — `flagship` (conversational realtime). → landed 2026-07-05.** New `channel/realtime-voice.ts`
  (the `gpt-realtime-2` session: `output_audio` deltas buffered → WAV-wrapped `speech` message, input
  transcription → compose, PTT commit + `response.create`, `response.cancel` barge-in on talk-start,
  a per-thread response cap), the `"openai-voice"` transcriber value (reuses the S2 PcmSource path),
  and `realtimeTools: "none"`. Reuses T2's `speech` message + player and the S1 `onClose` teardown.
  Live: user transcript (the IR) ~0.5–0.9 s after release, spoken reply playable ~1.4–1.6 s after
  release, ~0.6–0.8¢/turn (short utterances). `gpt-realtime-2` confirmed real + current.
- **T4 — `flagship` function-calling v2 (`realtimeTools: "page"`).** The curated page-tools bridge
  with its allowlist + confirmation surface and its own security review. Gated on T3 dogfooding.
  **Not built** (the `submit_intent` v1.5 tool is also deferred — v1 ships `none`).

## Divergences found in implementation (landed 2026-07-05)

The spec held; the corrections are small and were verified against the live endpoints:

1. **The flagship conversational endpoint wants the model as a URL query param.** Unlike the
   transcription endpoint (`?intent=transcription`, model in `session.update`), the GA conversational
   socket 400s a bare URL — *"You must provide a model parameter, for example
   `wss://api.openai.com/v1/realtime?model=…`"*. `realtime-voice.ts` appends `?model=<model>` to the
   URL (and still sends it in `session.update`, harmlessly). Verified live 2026-07-05.
2. **Model reply audio is WAV-wrapped before the `speech` message.** The doc's "buffer `output_audio.delta`
   into one base64 `speech` message" is right, but the deltas are raw `audio/pcm` — which a page
   `<audio>` element cannot play. So `realtime-voice.ts` wraps the buffered PCM16 in a 44-byte WAV header
   (`pcm16ToWav`) and the clip ships as `mime: "audio/wav"`. TTS acks are already `audio/mpeg` (mp3) and
   ship as-is. (Follow-up unchanged: streamed chunks if replies grow long.)
3. **`speech` message field names.** As built: `{ kind:"speech", threadId, id, mime, data, label? }` —
   `id` is a per-thread clip id (`ack_N` / the model `responseId`), `data` is the base64 (not
   `audioBase64`), `label` is the spoken text for the widget's speaker line + the trace.
4. **Delta-trap rule, made precise.** Implemented exactly as choice #5's *rule* states — when the applied
   delta carries a `tier`, a tier-controlled fine field is kept **iff it diverges from the new tier's
   preset** (so `set_config({ tier:"flagship", model:"whisper-1" })` keeps `model`, while a field equal to
   the new preset is re-derived by expansion). The prose example ("switching flagship→standard strips
   audioBack") slightly overstates it: a *stale* editor value that happens to differ from the new preset
   is kept (an accepted, harmless imperfection — the field is inert for the new tier, and the agent path,
   which sends only `{ tier }`, never hits it). This is the only place reality is looser than the prose.
5. **`realtimeReasoning` is carried, not yet wired.** The doc's session shape (correctly) omits a reasoning
   field; `realtimeReasoning` rides the config + trace but is not sent on the wire in v1 (its wire location
   is honest-unknown #4). The flagship session uses the model default effort.
6. **Cost guard.** The doc was silent on a hard cap, so a conservative **per-thread response cap**
   (`DEFAULT_MAX_RESPONSES = 8`) suppresses further `response.create`s once hit — loudly noted, and the STT
   lowering keeps feeding the IR (only the model's *speaking* is capped, never the dictation).

Order: T1 (pure config, immediate) → T2 (independent UX, = S4) → T3 (the flagship backend) → T4 (gated).

## Honest unknowns

1. **While-speaking liveness is unproven from OpenAI STT.** `gpt-realtime-whisper` = 0 partials before
   commit (measured); `gpt-4o-transcribe` realtime deltas reportedly batch at end-of-turn. Whether
   server-VAD chunking (dropping manual commit) yields true interim results is untested — the bench's
   `--realtime=` sweep is where we'd find out. Until then, no tier promises a filling text preview; if
   we ever want it, Deepgram is the seam-compatible fallback.
2. **Flagship real-world $/hr is context-sensitive.** The audio math is stable (~$0.02/min in,
   ~$0.077/min spoken), but the *instructions + accumulated context re-billed every turn* can 2–8× the
   bill (a documented realtime-cost trap). The ~$1–6/active-hr estimate assumes a short persona and
   modest context; a capped live probe should pin it before it's a recommended default.
3. **Does `gpt-realtime-2` image-in work over the session at useful resolution?** (audio-stack L3
   unknown.) The intent tool's screenshots are its multimodal payload; whether they can ride the
   flagship session or must stay REST attachments is a T3+ spike.
4. **`gpt-realtime-2`'s reasoning latency.** It is a reasoning voice model with configurable effort;
   higher effort adds latency and output tokens. Where the felt-conversational sweet spot sits
   (`realtimeReasoning`) is a dogfood question.
5. **Should the default tier ever move to `rapid`?** `rapid` is a clean 2.2× latency win for pennies→
   dimes; if dogfooding says the ~1.4 s `standard` wait is the main pain, moving the default is a
   one-line change — but it changes the billing surprise profile, so it stays opt-in until measured.

## Open decisions (with recommendations)

1. **Tier names** — `standard`/`rapid`/`premium`/`flagship` (**recommend**; reuses the user's words,
   names the felt experience) vs the pure-cost coin ladder `penny`/`nickel`/`dime`/`dollar` (more
   cost-honest but mis-separates the two "dime" rungs). One-line veto for the user.
2. **`flagship` transcriber value** — a new `"openai-voice"` enum on `transcriber` (**recommend**; a
   conversational session is a distinct shape, exactly as `"openai-realtime"` was) vs an orthogonal
   `audioBack:"voice"` boolean-ish. Keep one seam-selector.
3. **Flagship keeps the STT lowering vs the model *is* the lowering** — input-transcription feeds
   `composeIntent` as today, voice is a layer on top (**recommend v1**; the IR never depends on the
   opaque model) vs `submit_intent` tool-call as the sole IR (audio-stack L3; ship as opt-in v1.5, not
   the default).
4. **Function-calling v1** — `none` (**recommend**; zero page reach, nothing irreversible) vs one
   `submit_intent` tool. The page-tools bridge (`"page"`) is explicitly v2 with its own review.
5. **Audio-back transport for flagship** — buffer `output_audio.delta` into one base64 `speech` message
   per response (**recommend**; reuses S4, fine for short acks/answers) vs streamed chunks/binary
   (promote only when spoken answers grow long).
6. **Default tier** — `standard` = today's exact behavior (**recommend**; zero billing surprise,
   unchanged default) vs `rapid` (revisit after dogfooding per unknown #5).

## Reading list

`handoff/streaming-turns.md` (the S1–S3 realtime STT + S4 audio-back this builds on; §3 the realtime
session, §4 the base64 `speech` message, §5 the test tiers, T6 the measured 655 vs 1427 ms) ·
`workbench/docs/openai-audio-stack.md` (the L0–L3 ladder and cost frame this promotes; note its
forward-dated model names, corrected in Part 2) · `packages/aiui-dev-overlay/src/intent-pipeline/config.ts`
(`IntentPipelineConfig` + `DEFAULT_INTENT_CONFIG` — where `tier` and `TIER_PRESETS` land) ·
`packages/aiui-dev-overlay/src/multimodal/advanced-config.ts` (`SCHEMA`, `effectiveConfig`,
`computeOverrides` — the expansion + tier-switch-delta edits) · `packages/aiui-dev-overlay/src/overlay-tools.ts`
(`set_config` — inherits `tier` for free) · `packages/aiui-claude-channel/src/{transcribe,correct,realtime}.ts`
(the wired seams) + `intent-v1.ts` (`resolveIntent`, seam resolution, preflight) ·
`packages/aiui/test/openai-{pipeline,realtime}.e2e.ts` + `bench/transcribe-bench.ts` (the test surfaces
each tier extends). OpenAI docs verified July 2026:
[Pricing](https://developers.openai.com/api/docs/pricing),
[gpt-realtime-2](https://developers.openai.com/api/docs/models/gpt-realtime-2),
[Realtime](https://developers.openai.com/api/docs/guides/realtime),
[Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).
