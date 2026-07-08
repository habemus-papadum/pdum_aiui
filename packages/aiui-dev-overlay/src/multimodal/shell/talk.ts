/**
 * The multimodal modality's **talk lanes** — framework-free plumbing extracted
 * from modality.ts (proposal B2.4), which composes it and remains the only
 * caller.
 *
 * Two capture lanes behind one `talkStart`/`talkEnd` pair, chosen per talk
 * from the live config: the REST lane ({@link AudioCapture} — one
 * MediaRecorder run per segment, whole blob uploaded, or transcribed locally
 * by the mock) and the realtime lane (a {@link PcmSource} streaming Int16 PCM
 * frames while you talk). The mic-permission degraded paths live here too:
 * no mic / no AudioWorklet names the fix and never silently switches
 * backends.
 *
 * A talk window is bounded ONLY by the explicit gestures (Space hold/toggle,
 * window blur). The ~900 ms silence endpointer that used to auto-split a
 * hold into utterance segments — REST pseudo-streaming, and the correction
 * bar's hands-free segmenter — was REMOVED in the append-only pivot along
 * with correct mode itself: streaming transcription delivers deltas during
 * the window, and segment placement is the compiler's job now, at the
 * semantic level rather than the audio-waveform level.
 *
 * Owns its state (capture sources, listening flag); talks to the engine, the
 * wire, and the host context only through {@link TalkDeps}.
 */

import type { OverlayErrorInput } from "../../errors";
import type { IntentThread } from "../../intent";
import type { Engine, IntentPipelineConfig } from "../../intent-pipeline";
import { AudioCapture, type PcmSource } from "../audio";
import { mockTranscriber, type Transcriber } from "../transcribe";

/** What the talk lanes need from their composer (modality.ts). */
export interface TalkDeps {
  engine: Engine;
  /**
   * The live effective config. It is mutated **in place** by the modality's
   * `applyEffective`, so it must be read through this thunk at use time —
   * never destructured or copied at construction.
   */
  config: () => IntentPipelineConfig;
  /** Build the realtime PCM capture source (the composer resolves the test seam). */
  pcmSource: () => PcmSource;
  /** `ctx.setStatus` — the panel-footer status line. */
  setStatus: (text: string) => void;
  /** `ctx.reportError` — the dismissible, deduping toast. */
  reportError: (error: OverlayErrorInput) => void;
  /**
   * SpeechPlayer.bargeIn — talking over a playing ack/reply cuts it off. The
   * player is created after this module in the composer; talk only starts on
   * user interaction post-mount, so a deferred thunk is safe.
   */
  bargeIn: () => void;
  /** wire.getThread — undefined means degraded (no channel). */
  getThread: () => Promise<IntentThread | undefined>;
  /** wire.flushOutbox — talk-end must reach the server past the debounce. */
  flushOutbox: (known?: IntentThread) => Promise<void>;
  /** wire.uploadAttachment — a whole REST audio segment (`seg_N`). */
  uploadAttachment: (id: string, mime: string, bytes: Uint8Array) => Promise<void>;
  /** wire.uploadAudio — one streamed PCM frame of a talk segment. */
  uploadAudio: (segment: number, seq: number, bytes: Uint8Array) => Promise<void>;
}

/** The talk surface modality.ts (dispatch, HUD meter) drives. */
export interface Talk {
  /** The current mic level (whichever lane is live) — feeds the HUD meter. */
  level(): number;
  /** Whether the main loop still wants the mic. */
  listening(): boolean;
  /** Space pressed: start the main listening loop. */
  startMainListening(): void;
  /** Space released: stop wanting to listen, then end the segment. */
  stopMainListening(): void;
  /** Window blur: away = mic off (the window commits, never discards). */
  stopAllListening(): void;
  /** Unmount: release both capture lanes. */
  dispose(): void;
}

/**
 * Whether the config streams PCM during talk (the AudioWorklet path) rather than
 * recording a whole segment for REST upload. Three cases share the client
 * capture path (model-tiers.md: `openai-voice` wires audio exactly like
 * `openai-realtime`; only the channel-side session differs):
 *  - the realtime STT transcriber (`openai-realtime`, rapid/premium),
 *  - the flagship conversational voice session (`openai-voice`),
 *  - the **realtime submode** (any live tier): the Gemini/OpenAI live engines
 *    eat PCM as activity-window audio, so a live tier streams regardless of
 *    which `transcriber` its preset left in place.
 */
function usesPcmStream(config: IntentPipelineConfig): boolean {
  return (
    config.transcriber === "openai-realtime" ||
    config.transcriber === "openai-voice" ||
    config.submode === "realtime"
  );
}

export function createTalk(deps: TalkDeps): Talk {
  const { engine, config, setStatus, reportError, getThread, flushOutbox, uploadAttachment } = deps;

  const audio = new AudioCapture();
  // The realtime (streaming) capture source, built lazily on the first
  // realtime talk. Injectable so jsdom tests supply a fake for the AudioWorklet.
  const makePcmSource = deps.pcmSource;
  let pcmSource: PcmSource | undefined;
  // The segment whose PCM is currently streaming, and its next frame ordinal.
  let pcmSegment: number | undefined;
  let pcmSeq = 0;

  const mockStt = mockTranscriber({
    wordMs: () => config().mockWordMs,
    typoRate: () => config().mockTypoRate,
  });

  let mainListening = false;
  const listening = (): boolean => mainListening;
  const level = (): number => (usesPcmStream(config()) ? (pcmSource?.level() ?? 0) : audio.level());

  // Main-loop listening (Space pressed/toggled): one talk window per gesture.
  const startMainListening = (): void => {
    mainListening = true;
    void talkStart();
  };
  // Space released — the keymap sends this unconditionally.
  const stopMainListening = (): void => {
    mainListening = false;
    void talkEnd();
  };
  // Window blur STOPS LISTENING. The open window ENDS (commits — talkEnd
  // uploads/flushes; it never discards): the user turned away mid-thought,
  // and a mic left open on another window once transcribed a whole spoken
  // conversation on the API bill. Away = mic off.
  const stopAllListening = (): void => {
    mainListening = false;
    void talkEnd();
  };

  // ── talk plumbing (mock local / channel upload / realtime stream) ─────────
  async function talkStart(): Promise<void> {
    // Barge-in: talking over a playing ack/reply cuts it off locally (the
    // channel cancels the upstream response in parallel).
    deps.bargeIn();
    // The realtime STT transcriber AND the conversational voice sessions
    // stream PCM during talk — a separate capture path (AudioWorklet, not
    // MediaRecorder). Read dynamically so an advanced-config switch applies on
    // the next talk.
    if (usesPcmStream(config())) {
      await realtimeTalkStart();
      return;
    }
    // Only the channel (openai) transcriber reads audio. The mock ignores it
    // entirely, so we must NOT touch the mic for it — `getUserMedia` blocks on
    // an unanswered permission prompt, and awaiting that here would stall the
    // whole turn (no REC, no preview) until the user answers a prompt the mock
    // never needed. Gating on `needsAudio` keeps Space usable immediately with
    // the default transcriber even if the mic is unprompted or denied.
    const needsAudio = config().transcriber === "openai";
    // For openai, acquire the stream BEFORE marking the segment so recording
    // aligns with REC (no late-silent capture). The mock skips the await.
    const hasMic = needsAudio ? await audio.ensureStream() : false;
    const segment = engine.talkStart();
    if (segment === undefined) {
      return;
    }
    if (needsAudio && hasMic) {
      audio.start();
    } else if (needsAudio) {
      setStatus("no microphone — dictation needs mic access");
      reportError({
        source: "audio",
        message: "no microphone — dictation needs mic access (the segment will be silent)",
      });
    }
  }

  async function talkEnd(): Promise<void> {
    if (!engine.talking) {
      return;
    }
    if (usesPcmStream(config())) {
      await realtimeTalkEnd();
      return;
    }
    const segment = currentSegment();
    engine.talkEnd();
    const blob = (await audio.stop()) ?? new Blob([], { type: "audio/webm" });
    if (config().transcriber === "mock") {
      await transcribeLocally(mockStt, segment, blob);
      return;
    }
    // Channel transcriber: upload the segment; the transcript-final echoes back.
    const thread = await getThread();
    if (!thread) {
      engine.transcriptFinal(segment, "", 0, "openai");
      const message =
        'transcription needs the channel — launch through `aiui claude`, or set transcriber:"mock" for offline work';
      setStatus(message);
      reportError({ source: "connection", message });
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await uploadAttachment(`seg_${segment}`, blob.type || "audio/webm", bytes);
  }

  // ── realtime (streaming) talk: PCM frames stream during talk ──────────────
  async function realtimeTalkStart(): Promise<void> {
    if (!pcmSource) {
      pcmSource = makePcmSource();
    }
    // Start capture BEFORE marking the segment so frames align with REC.
    const started = await pcmSource.start(streamPcmFrame);
    const segment = engine.talkStart();
    if (segment === undefined) {
      if (started) {
        void pcmSource.stop();
      }
      return;
    }
    if (!started) {
      // No mic / no AudioWorklet — say so, and DON'T silently fall back (the
      // project posture: name the fix, never switch backends behind the user).
      const message =
        'realtime dictation needs mic + AudioWorklet, unavailable here — try transcriber:"openai" (REST) or "mock" for offline work';
      setStatus(message);
      reportError({ source: "audio", message });
      return;
    }
    pcmSegment = segment;
    pcmSeq = 0;
  }

  async function realtimeTalkEnd(): Promise<void> {
    const segment = currentSegment();
    engine.talkEnd();
    pcmSegment = undefined;
    // Stop capture: its tail frame(s) are delivered + queued for upload here,
    // before the talk-end commit below.
    await pcmSource?.stop();
    const thread = await getThread();
    if (!thread) {
      engine.transcriptFinal(segment, "", 0, "openai-realtime");
      const message =
        'realtime transcription needs the channel — launch through `aiui claude`, or set transcriber:"mock" for offline work';
      setStatus(message);
      reportError({ source: "connection", message });
      return;
    }
    // Flush the outbox NOW, past the 60 ms events debounce, so talk-end reaches
    // the server — and commits the upstream buffer — promptly, after the audio
    // frames already queued above (streaming-turns.md §3).
    await flushOutbox(thread);
  }

  /** One captured PCM frame → an `audio` chunk on the current segment, in seq order. */
  function streamPcmFrame(frame: Int16Array): void {
    if (pcmSegment === undefined) {
      return; // a stray frame before the segment opened (or after it closed)
    }
    const segment = pcmSegment;
    const seq = pcmSeq++;
    // Copy into a fresh little-endian buffer — the worklet may reuse `frame`.
    const bytes = new Uint8Array(Int16Array.from(frame).buffer);
    void deps.uploadAudio(segment, seq, bytes);
  }

  async function transcribeLocally(
    transcriber: Transcriber,
    segment: number,
    blob: Blob,
  ): Promise<void> {
    try {
      const result = await transcriber.transcribe(blob, (text) =>
        engine.transcriptDelta(segment, text),
      );
      engine.transcriptFinal(segment, result.text, result.latencyMs, result.model);
    } catch (error) {
      engine.events.push({
        at: Date.now(),
        type: "note",
        text: `transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      engine.transcriptFinal(segment, "", 0, transcriber.name);
    }
  }

  function currentSegment(): number {
    for (let i = engine.events.length - 1; i >= 0; i--) {
      const event = engine.events[i];
      if (event.type === "talk-start") {
        return event.segment;
      }
    }
    return 0;
  }

  return {
    level,
    listening,
    startMainListening,
    stopMainListening,
    stopAllListening,
    dispose: () => {
      audio.dispose();
      pcmSource?.dispose();
    },
  };
}
