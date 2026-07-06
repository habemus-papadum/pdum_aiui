/**
 * The multimodal `IntentModality` — the workbench's turn system, graduated into
 * the overlay and speaking the `intent-v1` wire format.
 *
 * One `Engine` (the append-only event stream + thread state machine) drives ink,
 * region screenshots with a component locator, hold-to-talk dictation with a
 * streaming preview, and the select-and-speak correction meta-loop. The
 * interaction is exactly the one designed in the workbench (see its
 * `docs/turn-flow.md`): backtick arms, Space talks, drag inks, D drag-shoots a
 * region, S shoots the whole viewport, C clears, E enters correct mode, Enter
 * sends, Esc steps out one level.
 *
 * Where the workbench was a standalone bench — mock transcriber, dev-proxy for
 * the real model, self-annotated scenery — this modality streams the turn to
 * the channel over `intent-v1`:
 *  - the event log rides `chunk{kind:"events"}` JSON frames, batched on a short
 *    debounce as the stream grows;
 *  - shot PNGs and (for the `openai` transcriber) audio segments ride
 *    `chunk{kind:"attachment"}` raw-binary frames, correlated to their `shot`/
 *    `talk` event by id (`shot_N` / `seg_N`);
 *  - an optional `chunk{kind:"context"}` carries the page selection just before
 *    the thread's `fin` frame on send;
 *  - the server lowers and pushes echoes back — a segment's `transcript-final`,
 *    a completed `correction` — which merge into the engine stream as if local.
 *
 * Everything degrades: no channel port / an old server that refuses the format →
 * composing still works locally and the send reports the error; no mic → talk
 * is inert with a hint; no capture grant → shots carry the rect + components,
 * no pixels.
 */

import { makeDraggable } from "../drag";
import type { IntentModality, IntentThread, IntentToolContext } from "../intent";
import { toSelectionPayload } from "../intent";
import {
  type CorrectionTarget,
  composeIntent,
  Engine,
  type IntentEvent,
  type IntentPipelineConfig,
  type IntentTier,
  isTypingTarget,
  type KeyCommand,
  keyCommand,
} from "../intent-pipeline";
import { installOverlayTools, type OverlayReport, type SetConfigResult } from "../overlay-tools";
import type { Ack, VideoChunk } from "../protocol";
import { intentTurnStore } from "../turn-store";
import {
  clearIntentOverrides,
  effectiveConfig,
  loadIntentOverrides,
  mountAdvancedConfig,
  overridesForApply,
  saveIntentOverrides,
  validateIntentConfig,
} from "./advanced-config";
import { AudioCapture, type PcmSource, REALTIME_PCM_MIME, WorkletPcmSource } from "./audio";
import { ConfigStrip, type ConfigStripState } from "./config-strip";
import { type CorrectionDiff, mockCorrector } from "./correct";
import { Ink } from "./ink";
import { Preview } from "./preview";
import { canvasJpegBytes, ShotTool } from "./shot";
import { type SpeechAudioFactory, SpeechPlayer } from "./speech";
import { STYLES } from "./styles";
import { mockTranscriber, type Transcriber } from "./transcribe";
import { sampleDimensions, VIDEO_FRAME_MIME, VIDEO_JPEG_QUALITY, VideoSampler } from "./video";

/** How long to accumulate engine events before flushing an events chunk. */
const EVENTS_DEBOUNCE_MS = 60;
/** How long to wait for a correction echo before falling back to plain replace. */
const CORRECTION_TIMEOUT_MS = 8000;

interface PendingDiff {
  resolve: (diff: CorrectionDiff) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Injected seams for tests (jsdom has no AudioWorklet / no real audio playback). */
export interface MultimodalDeps {
  /** Build the realtime PCM capture source; defaults to {@link WorkletPcmSource}. */
  pcmSource?: () => PcmSource;
  /**
   * Build the audio element the {@link SpeechPlayer} plays server-pushed clips
   * through; defaults to `new Audio(src)`. Injected in jsdom, which can't play.
   */
  speechAudio?: SpeechAudioFactory;
  /**
   * The realtime video sampler's cadence in ms; defaults to
   * {@link VIDEO_SAMPLE_INTERVAL_MS} (~1 fps). Injected only by tests, which
   * shorten it so a couple of sampled frames flow within a `wait()`.
   */
  videoSampleIntervalMs?: number;
}

/**
 * The multimodal modality, optionally seeded with client-side pipeline config
 * (talk mode, ink fade, transcriber/corrector choice, arming rebind, …). The
 * effective config rides the hello so a lowering trace records it.
 */
export function multimodalModality(
  viteOption: Partial<IntentPipelineConfig> = {},
  deps: MultimodalDeps = {},
): IntentModality {
  return {
    format: "intent-v1",
    label: "Multimodal",
    mount(container: HTMLElement, ctx: IntentToolContext) {
      // Config layers: DEFAULT ← tier preset ← Vite intent option ← persisted
      // panel overrides. `viteOption` is threaded RAW (not pre-merged with
      // DEFAULT) so the tier expansion can tell "set on purpose" from a default
      // (model-tiers.md, choice #4). `base` is DEFAULT+preset+vite (the layer the
      // persisted delta sits on); `config` is the effective one, mutated in place
      // so dynamic reads + the next hello pick up live edits.
      const base: IntentPipelineConfig = effectiveConfig(viteOption, {});
      const config: IntentPipelineConfig = effectiveConfig(viteOption, loadIntentOverrides());
      const engine = new Engine(config);
      const audio = new AudioCapture();
      // The realtime (streaming) capture source, built lazily on the first
      // realtime talk. Injectable so jsdom tests supply a fake for the AudioWorklet.
      const makePcmSource = deps.pcmSource ?? (() => new WorkletPcmSource());
      let pcmSource: PcmSource | undefined;
      // The segment whose PCM is currently streaming, and its next frame ordinal.
      let pcmSegment: number | undefined;
      let pcmSeq = 0;
      // The durable turn store: survives a soft remount in memory, and mirrors
      // to sessionStorage so a full reload (an overlay-source edit under the dev
      // server — see turn-store.ts) can still recover the in-progress turn.
      const turn = intentTurnStore();

      // ── page-level interaction layers (light DOM: native selection must
      // resolve against the preview text, per field-notes) ────────────────────
      const style = document.createElement("style");
      style.textContent = STYLES;
      document.head.append(style);

      const layers = document.createElement("div");
      layers.className = "mm-layers";

      const mockStt = mockTranscriber({
        wordMs: () => config.mockWordMs,
        typoRate: () => config.mockTypoRate,
      });

      const ink = new Ink({
        fadeSec: () => config.inkFadeSec,
        onStroke: (points, bounds) => engine.strokeDone(points, bounds),
        onAutoClear: () => engine.inkCleared(true),
      });
      layers.append(ink.canvas);

      const shots = new ShotTool(ink, (rect, components, viewport, thumb, bytes) => {
        // A capture can resolve long after the gesture — the first shot blocks
        // on the getDisplayMedia picker — by which time the turn may have been
        // sent or cancelled (send disarms). A disarmed engine means this shot
        // has no turn to join: drop it, or the straggler event lands after the
        // preview cleared and its thumb haunts the next arm.
        if (!engine.armed) {
          return;
        }
        // No dev-proxy: the channel assigns the on-disk path from the uploaded
        // bytes, so the shot event carries no path — its marker correlates it
        // with the attachment frame.
        const marker = engine.shotDone(rect, components, thumb, undefined, viewport);
        if (bytes) {
          void uploadAttachment(marker, "image/png", bytes);
        }
      });
      layers.append(shots.veil);

      // ── the realtime submode's screen sampler (V) ────────────────────────────
      // While sharing (a live tier only), sample the SAME display-capture stream
      // the shots grab from — one grant serves both — at ~1 fps into `video`
      // chunks: unlabeled ambient context for the live model (deliberate shots
      // stay the referenceable artifacts). `videoShareOrdinal` bumps per
      // toggle-on (`vid_N`); the sampler counts the frame `seq` within one share.
      // `captureVideoFrame` / `uploadVideo` are hoisted declarations below.
      let videoShareOrdinal = 0;
      const videoSampler = new VideoSampler({
        captureFrame: () => captureVideoFrame(),
        sendFrame: (seq, bytes) => void uploadVideo(seq, bytes),
        ...(deps.videoSampleIntervalMs !== undefined
          ? { intervalMs: deps.videoSampleIntervalMs }
          : {}),
      });

      // ── silence-endpointed listening (main loop + correction box) ────────────
      // Utterances end on *silence*: once the level meter has heard voice, ~a
      // second of quiet ends the segment and — while listening is still wanted
      // — immediately starts the next one. Two surfaces want it:
      //  - the MAIN loop (Space held / toggled): each utterance uploads and
      //    transcribes as you pause, so REST behaves like streaming — the
      //    preview fills utterance by utterance instead of all-at-release;
      //  - the CORRECTION box, which has no push-to-talk boundary at all
      //    (Space types spaces there) — silence is its only segmenter.
      // Done browser-side off the existing AnalyserNode/worklet level (server
      // VAD would only cover the realtime tiers; this covers REST too). The
      // mock's level is always 0, so mock segments end only on the explicit
      // gestures — which keeps every test deterministic.
      const ENDPOINT_VOICE_LEVEL = 0.05;
      const ENDPOINT_SILENCE_MS = 900;
      let mainListening = false;
      let correctionListening = false;
      const listening = (): boolean => mainListening || correctionListening;
      let endpointTimer: ReturnType<typeof setInterval> | undefined;
      const stopEndpointer = (): void => {
        if (endpointTimer) {
          clearInterval(endpointTimer);
          endpointTimer = undefined;
        }
      };
      // Whether the CURRENT segment has heard voice — mount-scoped because the
      // correction bar's empty-Enter needs it (see CorrectionVoiceHooks.heard):
      // hands-free listening keeps a silent segment open, so `engine.talking`
      // alone can't distinguish "just spoke" from "sitting in silence".
      let heardVoice = false;
      const startEndpointer = (): void => {
        if (endpointTimer) {
          return; // one poller serves however many surfaces are listening
        }
        let lastVoicedAt = Date.now();
        endpointTimer = setInterval(() => {
          if (!listening() || !engine.talking) {
            heardVoice = false; // between segments — a stale flag must not end the next one early
            return;
          }
          const level = usesPcmStream(config) ? (pcmSource?.level() ?? 0) : audio.level();
          if (level > ENDPOINT_VOICE_LEVEL) {
            heardVoice = true;
            lastVoicedAt = Date.now();
            return;
          }
          if (heardVoice && Date.now() - lastVoicedAt > ENDPOINT_SILENCE_MS) {
            heardVoice = false; // this utterance is over; transcribe it…
            void talkEnd().then(() => {
              if (listening()) {
                void talkStart(); // …and keep listening for the next one
              }
            });
          }
        }, 100);
      };
      const startCorrectionListening = (): void => {
        correctionListening = true;
        startEndpointer();
        void talkStart();
      };
      const stopCorrectionListening = (): void => {
        correctionListening = false;
        if (!listening()) {
          stopEndpointer();
        }
        void talkEnd();
      };

      // The preview borrows the talk plumbing for the correction bar: the mic
      // goes live hands-free while the bar is open, streamed speech renders in
      // its live zone, and Enter ends the segment before committing.
      // `talkStart`/`talkEnd` are function declarations (hoisted); the hooks
      // only fire on user interaction, post-mount.
      const preview = new Preview(engine, {
        start: startCorrectionListening,
        stop: stopCorrectionListening,
        talking: () => engine.talking,
        heard: () => heardVoice,
      });
      layers.append(preview.root);

      // ── HUD (arm button + state + level meter) ───────────────────────────────
      const hud = document.createElement("div");
      hud.className = "mm-hud";
      hud.innerHTML = `
        <button class="mm-arm" title="arm/disarm">✳</button>
        <span class="mm-state">off</span>
        <span class="mm-video" hidden>● video</span>
        <canvas class="mm-meter" width="60" height="14"></canvas>
        <span class="mm-keys">${armKeyLabel(config)} arm · Space talk · drag ink · D region-shot · S viewport-shot · C clear · E correct · V video · K config · ⏎ send · Esc out</span>
        <span class="mm-speaker" hidden></span>`;
      layers.append(hud);

      // The quick-config strip (the K layer) sits just above the HUD. Clicks
      // on its chips/actions route into the same dispatch as the keymap
      // (`dispatch` is defined below; strip clicks can only happen post-mount).
      const strip = new ConfigStrip((command) => dispatch(command));
      layers.append(strip.root);
      document.body.append(layers);

      // Both floating surfaces move out of the way by dragging (they cover app
      // content by construction). They sit above the ink canvas and shot veil,
      // so a drag on them is never a stroke or a screenshot. The preview only
      // drags by its frame/title — inside the transcript body a drag *is* the
      // correction-targeting selection gesture, and the correction bar holds an
      // input — both stay excluded.
      const undragHud = makeDraggable(hud);
      const undragPreview = makeDraggable(preview.root, {
        exclude: (target) => target.closest(".mm-preview-body, .mm-correction-bar") !== null,
      });
      const armButton = hud.querySelector<HTMLButtonElement>(".mm-arm");
      const stateLabel = hud.querySelector<HTMLSpanElement>(".mm-state");
      const videoBadge = hud.querySelector<HTMLSpanElement>(".mm-video");
      const meter = hud.querySelector<HTMLCanvasElement>(".mm-meter");
      const keysLabel = hud.querySelector<HTMLSpanElement>(".mm-keys");
      const speakerLabel = hud.querySelector<HTMLSpanElement>(".mm-speaker");
      armButton?.addEventListener("click", () => engine.setArmed(!engine.armed));

      // The server → page speech player (premium TTS acks + flagship model
      // replies). It plays whatever `speech` messages arrive, gated on audioBack
      // (a client-side mute), one clip at a time, ducking on talk-start (barge-in).
      const setSpeaker = (label: string | undefined): void => {
        if (!speakerLabel) {
          return;
        }
        speakerLabel.hidden = label === undefined;
        speakerLabel.textContent = label === undefined ? "" : `🔊 ${label}`;
      };
      const speechPlayer = new SpeechPlayer({
        ...(deps.speechAudio !== undefined ? { createAudio: deps.speechAudio } : {}),
        onSpeak: (label) => setSpeaker(label ?? "…"),
        onIdle: () => setSpeaker(undefined),
      });

      // ── the panel body: a short help block (interaction is page-level) ───────
      const help = document.createElement("div");
      help.className = "mm-help";
      help.style.cssText = "color:#cfd3da;font-size:12px;line-height:1.6;";
      container.append(help);
      // Re-rendered on an advanced-config apply (the arm key may have changed).
      const renderLabels = (): void => {
        const key = armKeyLabel(config);
        help.innerHTML = `Press <b>${key}</b> to arm, then <b>Space</b> to talk, drag to sketch,
          <b>D</b>+drag to screenshot a region (<b>S</b> grabs the whole viewport),
          <b>E</b> to correct, <b>V</b> to share your screen (live tiers only),
          <b>K</b> for quick config (tiers), <b>Enter</b> to send.
          A ✳ badge sits bottom-left while active.`;
        if (keysLabel) {
          keysLabel.textContent = `${key} arm · Space talk · drag ink · D region-shot · S viewport-shot · C clear · E correct · V video · K config · ⏎ send · Esc out`;
        }
      };
      renderLabels();

      let shooting = false;
      function renderHud(): void {
        if (!engine.armed) {
          strip.hide(); // disarming always closes the quick-config strip
        }
        // Enforce "no armed+ink state → no veil" here, where every dispatch
        // and engine event lands. The veil is stranded when D's keyup never
        // arrives — classically the first shot's getDisplayMedia picker
        // stealing focus mid-hold — and a stranded veil is a full-viewport
        // crosshair overlay the user can't click through, surviving disarm.
        if (shooting && (!engine.armed || engine.mode !== "ink")) {
          shots.setArmed(false);
          shooting = false;
        }
        // The screen share is bounded by the turn: it can't outlive the thread
        // (send/cancel/timeout) or a disarm. Enforce it here — where every
        // dispatch and engine event lands — the same way the shot veil is.
        if (videoSampler.sharing && (!engine.armed || !engine.threadOpen)) {
          videoSampler.stop();
        }
        document.body.classList.toggle("mm-armed", engine.armed);
        hud.classList.toggle("armed", engine.armed);
        hud.classList.toggle("talking", engine.talking);
        if (stateLabel) {
          stateLabel.textContent = !engine.armed
            ? "off"
            : `${engine.mode}${engine.talking ? " · REC" : ""}${engine.threadOpen ? " · thread" : ""}`;
        }
        if (videoBadge) {
          videoBadge.hidden = !videoSampler.sharing;
        }
        ink.setActive(engine.armed && engine.mode === "ink" && !shooting);
        preview.setCorrectMode(engine.armed && engine.mode === "correct");
        preview.root.classList.toggle("visible", engine.armed);
      }

      // A focus steal mid-D-hold (the display-capture picker, a cmd-tab) eats
      // the keyup itself: treat window blur as D-up. setArmed(false) already
      // defers the hide when a drag is genuinely in flight.
      //
      // Blur also STOPS ALL LISTENING. The auto-restarting hands-free mic has
      // no idea the user turned away — it once transcribed an entire spoken
      // conversation held in another window, segment by segment, on the API
      // bill. Away = mic off; refocusing re-arms it when the correction
      // editor is still open (the one surface that listens without a held key).
      const onWindowBlur = (): void => {
        if (shooting) {
          shots.setArmed(false);
          shooting = false;
        }
        if (listening() || engine.talking) {
          mainListening = false;
          correctionListening = false;
          stopEndpointer();
          void talkEnd();
        }
        // A screen share PAUSES on blur (rather than ending): the user glanced
        // away, and streaming the other window they turned to would be both
        // wrong context and wasted frames. Refocus resumes it (onWindowFocus)
        // if the share is still on — pause/resume is a no-op when not sharing.
        videoSampler.pause();
      };
      const onWindowFocus = (): void => {
        if (engine.armed && engine.mode === "correct" && !engine.talking) {
          startCorrectionListening();
        }
        videoSampler.resume();
      };
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);

      const meterCtx = meter?.getContext("2d") ?? null;
      const meterTimer = setInterval(() => {
        if (!meterCtx || !meter) {
          return;
        }
        meterCtx.clearRect(0, 0, meter.width, meter.height);
        const level = engine.talking
          ? usesPcmStream(config)
            ? (pcmSource?.level() ?? 0)
            : audio.level()
          : 0;
        meterCtx.fillStyle = engine.talking ? "#ff5c87" : "#3a4152";
        meterCtx.fillRect(0, 0, Math.max(2, level * meter.width), meter.height);
      }, 80);

      // ── the wire: one socket per thread, opened on thread-open ───────────────
      let threadPromise: Promise<IntentThread> | undefined;
      // The thread socket's lifecycle, surfaced in the overlay's report().
      let threadState: "none" | "connecting" | "open" | "failed" = "none";
      const outbox: IntentEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let merging = false;
      const pendingDiffs: PendingDiff[] = [];

      const rememberError = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.setStatus(`send unavailable: ${message}`);
      };

      /**
       * Surface a rejected frame — the server answered `ok:false` (thread
       * closed, decode failure, a processor throw, "connection closed" after a
       * drop). These acks used to be awaited and then dropped on the floor: the
       * turn kept composing while nothing was actually reaching the channel.
       * One toast per distinct error — the host dedupes, so a dead thread
       * rejecting every streamed PCM frame is one toast with a climbing ×N.
       */
      const reportBadAck = (what: string, ack: Ack): void => {
        if (ack.ok) {
          return;
        }
        ctx.reportError({
          source: "channel",
          message: `${what} rejected: ${ack.error ?? "unknown error"}`,
        });
      };

      const getThread = async (): Promise<IntentThread | undefined> => {
        if (!threadPromise) {
          return undefined;
        }
        try {
          return await threadPromise;
        } catch {
          return undefined;
        }
      };

      function openThreadSocket(): void {
        if (threadPromise) {
          return;
        }
        threadState = "connecting";
        // The effective config rides the hello (opaque `intent` meta) so the
        // trace records the whole configuration the events came from.
        threadPromise = ctx
          .openThread({ intent: config as unknown as Record<string, unknown> })
          .then((thread) => {
            threadState = "open";
            thread.onServerMessage((msg) => handleServerMessage(msg));
            return thread;
          });
        // Swallow the rejection here so it never surfaces as unhandled; callers
        // observe it via getThread() returning undefined.
        threadPromise.catch((error) => {
          threadState = "failed";
          rememberError(error);
        });
      }

      const scheduleFlush = (): void => {
        if (flushTimer) {
          return;
        }
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          void flushOutbox();
        }, EVENTS_DEBOUNCE_MS);
      };

      async function flushOutbox(known?: IntentThread): Promise<void> {
        const thread = known ?? (await getThread());
        if (!thread) {
          // No channel — composing continues locally; drop the un-sendable batch.
          outbox.length = 0;
          return;
        }
        if (outbox.length === 0) {
          return;
        }
        const batch = outbox.splice(0);
        try {
          reportBadAck(
            "event batch",
            await thread.sendChunk({ kind: "events" }, { events: batch }, false),
          );
        } catch (error) {
          rememberError(error);
        }
      }

      async function uploadAttachment(id: string, mime: string, bytes: Uint8Array): Promise<void> {
        const thread = await getThread();
        if (!thread) {
          return; // degraded: the shot/segment event still describes itself, no bytes
        }
        // Flush the correlated event first so the server has it when the bytes land.
        await flushOutbox(thread);
        try {
          reportBadAck(
            `attachment ${id}`,
            await thread.sendAttachment({ kind: "attachment", id, mime }, bytes, false),
          );
        } catch (error) {
          rememberError(error);
        }
      }

      async function finalizeThread(): Promise<void> {
        const thread = await getThread();
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (!thread) {
          resetThread();
          // The socket never opened (or failed at thread-open — the host
          // toasted the cause then). The user just hit SEND, so re-surface the
          // consequence now: the toast dedupe folds a repeat into ×N.
          ctx.setStatus("composed locally — no channel connected to send to");
          ctx.reportError({
            source: "connection",
            message: "not sent — no channel connected (the turn was composed locally only)",
          });
          return;
        }
        await flushOutbox(thread);
        const selection = ctx.selection();
        if (selection) {
          try {
            reportBadAck(
              "selection context",
              await thread.sendChunk(
                { kind: "context" },
                { selection: toSelectionPayload(selection) },
                false,
              ),
            );
          } catch (error) {
            rememberError(error);
          }
          ctx.clearSelection();
        }
        try {
          const ack = await thread.finish();
          if (ack.ok) {
            ctx.setStatus("sent ✓ — check the session (🔍 shows the lowering trace)");
          } else {
            ctx.setStatus(`send failed: ${ack.error ?? "unknown error"}`);
            reportBadAck("send (fin)", ack);
          }
        } catch (error) {
          // A fin that THROWS (vs. an ok:false ack) was the one send failure
          // that only reached the panel-footer status line — invisible with
          // the panel closed, i.e. exactly when the multimodal turn is used.
          rememberError(error);
          ctx.reportError({
            source: "channel",
            message: `send failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        resetThread();
      }

      async function cancelThread(): Promise<void> {
        const thread = threadPromise ? await getThread() : undefined;
        thread?.close();
        resetThread();
      }

      function resetThread(): void {
        threadPromise = undefined;
        threadState = "none";
        outbox.length = 0;
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        for (const pending of pendingDiffs.splice(0)) {
          clearTimeout(pending.timer);
          pending.reject(new Error("thread ended before the correction echo arrived"));
        }
      }

      // ── server → client: merge lowered echoes as if they happened locally ────
      function handleServerMessage(msg: { kind: string; [key: string]: unknown }): void {
        if (msg.kind === "lowered" && Array.isArray(msg.events)) {
          mergeLowered(msg.events as IntentEvent[]);
        } else if (
          msg.kind === "speech" &&
          typeof msg.mime === "string" &&
          typeof msg.data === "string"
        ) {
          // A spoken clip (a premium ack / a flagship reply). Play it unless the
          // client muted audio-back (audioBack:"off"); read live so a config
          // switch takes effect immediately.
          if (config.audioBack !== "off") {
            speechPlayer.enqueue({
              id: typeof msg.id === "string" ? msg.id : "speech",
              mime: msg.mime,
              data: msg.data,
              ...(typeof msg.label === "string" ? { label: msg.label } : {}),
            });
          }
        } else if (msg.kind === "lowered-prompt") {
          // Deliberately ignored: the overlay doesn't surface the final lowered
          // prompt (yet) — the workbench consumes this push server-side. See
          // LoweredPromptMessage in protocol.ts.
        }
      }

      function mergeLowered(events: IntentEvent[]): void {
        merging = true;
        try {
          for (const event of events) {
            if (event.type === "transcript-delta") {
              engine.transcriptDelta(event.segment, event.text);
            } else if (event.type === "transcript-final") {
              // Fills the preview for an uploaded segment; if a correction target
              // is still lassoed, the engine chains it into a correction.
              engine.transcriptFinal(event.segment, event.text, event.latencyMs, event.model);
            } else if (event.type === "correction") {
              resolveCorrectionEcho(event);
            } else if (event.type === "note") {
              ctx.setStatus(event.text);
            }
          }
        } finally {
          merging = false;
        }
      }

      function resolveCorrectionEcho(echo: Extract<IntentEvent, { type: "correction" }>): void {
        const waiter = pendingDiffs.shift();
        if (!waiter) {
          return;
        }
        clearTimeout(waiter.timer);
        if (echo.patch) {
          waiter.resolve({
            patch: echo.patch,
            model: echo.model ?? config.correctionModel,
            latencyMs: echo.latencyMs ?? 0,
          });
        } else {
          // No patch → the pipeline's plain-replacement fallback (never vanish).
          waiter.reject(new Error("correction echo had no patch"));
        }
      }

      const noteCorrectionFailure = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        // A silent log entry (push, not emit) — never streamed nor rendered.
        engine.events.push({
          at: Date.now(),
          type: "note",
          text: `correction pipeline failed (${config.corrector}): ${message} — applied as plain replacement`,
        });
        // ...and a user-facing status, so the fallback to plain replacement is
        // never silent about why the model correction didn't land. The toast
        // repeats it because correcting happens with the panel closed (the
        // preview is page-level) — a status line nobody can see is not "loud".
        ctx.setStatus(`correction applied as plain replacement — ${message}`);
        ctx.reportError({
          source: "correction",
          message: `correction applied as plain replacement — ${message}`,
        });
      };

      /**
       * Apply a resolved correction to the preview + local doc WITHOUT
       * re-streaming it. Used for the channel corrector: the server already
       * produced this correction from the patchless request (it runs the diff
       * and merges the completed correction into its OWN stream), so streaming
       * the resolution too would make the server apply it twice.
       */
      const applyCorrectionLocally = (
        target: CorrectionTarget,
        instruction: string,
        via: "speech" | "typed",
        diff?: CorrectionDiff,
      ): void => {
        const wasMerging = merging;
        merging = true;
        try {
          engine.correction(target, instruction, via, diff);
        } finally {
          merging = wasMerging;
        }
      };

      // ── the correction micro-pipeline (mock local / channel round-trip) ──────
      engine.correctionPipeline = (target, instruction, via) => {
        const allLines = composeIntent(engine.events, config.correctionPolicy)
          .items.filter((item) => item.kind === "text")
          .map((item) => item.text ?? "");
        // Scope the model's document to the active chunk (see the correction
        // event's `scope`): the patch stays context-anchored, so it lands in
        // the full transcript regardless.
        const docLines = target.scope
          ? allLines.slice(
              Math.max(0, target.scope.fromLine),
              Math.min(allLines.length, target.scope.toLine),
            )
          : allLines;
        if (config.corrector === "mock") {
          // Local patch: this correction event is the server's ONLY copy, so it
          // streams normally (the server, in mock mode, passes it through).
          void mockCorrector()
            .diff({ docLines, selected: target.original, instruction })
            .then((diff) => engine.correction(target, instruction, via, diff))
            .catch((error: unknown) => {
              noteCorrectionFailure(error);
              engine.correction(target, instruction, via);
            });
        } else {
          // Channel: the patchless request (sent inside requestChannelCorrection)
          // is what the server composes from; its echoed resolution is applied
          // locally only. A no-patch/timeout echo → plain replacement, also local.
          void requestChannelCorrection(target, instruction, via)
            .then((diff) => applyCorrectionLocally(target, instruction, via, diff))
            .catch((error: unknown) => {
              noteCorrectionFailure(error);
              applyCorrectionLocally(target, instruction, via, undefined);
            });
        }
      };

      /**
       * Channel corrector: stream the patchless correction as a request (an
       * events chunk, transient — not the engine's own event) and await the
       * server's patched echo. On timeout / no-patch, the pipeline above falls
       * back to plain replacement.
       */
      function requestChannelCorrection(
        target: CorrectionTarget,
        instruction: string,
        via: "speech" | "typed",
      ): Promise<CorrectionDiff> {
        return new Promise<CorrectionDiff>((resolve, reject) => {
          const timer = setTimeout(() => {
            const index = pendingDiffs.findIndex((p) => p.timer === timer);
            if (index >= 0) {
              pendingDiffs.splice(index, 1);
            }
            reject(new Error("correction timed out awaiting the channel echo"));
          }, CORRECTION_TIMEOUT_MS);
          const entry: PendingDiff = { resolve, reject, timer };
          pendingDiffs.push(entry);
          const reqEvent: IntentEvent = {
            at: Date.now(),
            type: "correction",
            from: target.from,
            to: target.to,
            original: target.original,
            instruction,
            via,
            ...(target.scope !== undefined ? { scope: target.scope } : {}),
          };
          void (async () => {
            const thread = await getThread();
            if (!thread) {
              const index = pendingDiffs.indexOf(entry);
              if (index >= 0) {
                pendingDiffs.splice(index, 1);
              }
              clearTimeout(timer);
              reject(new Error("no channel connected"));
              return;
            }
            await flushOutbox(thread);
            try {
              await thread.sendChunk({ kind: "events" }, { events: [reqEvent] }, false);
            } catch {
              // The timeout (or a later echo) settles this; nothing else to do.
            }
          })();
        });
      }

      // ── talk plumbing (mock local / channel upload / realtime stream) ─────────
      async function talkStart(): Promise<void> {
        // Barge-in: talking over a playing ack/reply cuts it off locally (the
        // channel cancels the upstream flagship response in parallel).
        speechPlayer.bargeIn();
        // The realtime STT transcriber AND the flagship voice session both stream
        // PCM during talk — a separate capture path (AudioWorklet, not
        // MediaRecorder). Read dynamically so an advanced-config switch applies on
        // the next talk.
        if (usesPcmStream(config)) {
          await realtimeTalkStart();
          return;
        }
        // Only the channel (openai) transcriber reads audio. The mock ignores it
        // entirely, so we must NOT touch the mic for it — `getUserMedia` blocks on
        // an unanswered permission prompt, and awaiting that here would stall the
        // whole turn (no REC, no preview) until the user answers a prompt the mock
        // never needed. Gating on `needsAudio` keeps Space usable immediately with
        // the default transcriber even if the mic is unprompted or denied.
        const needsAudio = config.transcriber === "openai";
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
          ctx.setStatus("no microphone — dictation needs mic access");
          ctx.reportError({
            source: "audio",
            message: "no microphone — dictation needs mic access (the segment will be silent)",
          });
        }
      }

      async function talkEnd(): Promise<void> {
        if (!engine.talking) {
          return;
        }
        if (usesPcmStream(config)) {
          await realtimeTalkEnd();
          return;
        }
        const segment = currentSegment();
        engine.talkEnd();
        const blob = (await audio.stop()) ?? new Blob([], { type: "audio/webm" });
        if (config.transcriber === "mock") {
          await transcribeLocally(mockStt, segment, blob);
          return;
        }
        // Channel transcriber: upload the segment; the transcript-final echoes back.
        const thread = await getThread();
        if (!thread) {
          engine.transcriptFinal(segment, "", 0, "openai");
          const message =
            'transcription needs the channel — launch through `aiui claude`, or set transcriber:"mock" for offline work';
          ctx.setStatus(message);
          ctx.reportError({ source: "connection", message });
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
          ctx.setStatus(message);
          ctx.reportError({ source: "audio", message });
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
          ctx.setStatus(message);
          ctx.reportError({ source: "connection", message });
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
        void uploadAudio(segment, seq, bytes);
      }

      async function uploadAudio(segment: number, seq: number, bytes: Uint8Array): Promise<void> {
        const thread = await getThread();
        if (!thread) {
          return; // degraded: no channel — realtimeTalkEnd reports it to the user
        }
        try {
          reportBadAck(
            "audio frame",
            await thread.sendAudio(
              { kind: "audio", id: `seg_${segment}`, seq, mime: REALTIME_PCM_MIME },
              bytes,
              false,
            ),
          );
        } catch (error) {
          rememberError(error);
        }
      }

      // ── realtime submode: the ~1 fps screen sampler (V) ──────────────────────
      /**
       * Toggle screen sharing. Only reached in the realtime submode (the dispatch
       * gates on it). Turning ON marks the share (which opens the thread + shows
       * the badge) *then* acquires the display-capture grant — the same one-time
       * picker a shot uses, auto-accepted in the session browser — so the thread
       * is already open when the sampler's immediate first frame lands. A denied
       * grant retracts the share honestly (badge off, an on→off in the trace)
       * rather than sampling blind.
       */
      async function toggleVideoShare(): Promise<void> {
        if (videoSampler.sharing) {
          videoSampler.stop();
          engine.videoShare(false);
          renderHud();
          return;
        }
        engine.videoShare(true);
        renderHud();
        const video = await shots.ensureCaptureStream();
        if (!engine.armed) {
          return; // disarmed during the picker — disarm already tore it all down
        }
        if (!video) {
          engine.videoShare(false);
          const message =
            "screen capture unavailable — video sharing needs a display-capture grant";
          ctx.setStatus(message);
          ctx.reportError({ source: "capture", message });
          renderHud();
          return;
        }
        videoShareOrdinal += 1;
        videoSampler.start();
        renderHud();
      }

      /** Draw the shared capture element to a downscaled JPEG frame, or undefined. */
      async function captureVideoFrame(): Promise<Uint8Array | undefined> {
        const video = await shots.ensureCaptureStream();
        if (!video) {
          return undefined; // grant lost mid-share — skip this frame
        }
        const { width, height } = sampleDimensions(video.videoWidth, video.videoHeight);
        const canvas = document.createElement("canvas");
        // Clamp to ≥1: a not-yet-ready element (videoWidth 0) yields a tiny frame
        // rather than a zero-dimension canvas — rare, since ensureStream awaits play().
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const c2d = canvas.getContext("2d");
        if (!c2d) {
          return undefined;
        }
        c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvasJpegBytes(canvas, VIDEO_JPEG_QUALITY);
      }

      /** One sampled frame → a `video` chunk on the current share, in seq order. */
      async function uploadVideo(seq: number, bytes: Uint8Array): Promise<void> {
        const thread = await getThread();
        if (!thread) {
          return; // degraded: no channel — the share simply doesn't stream
        }
        const chunk: VideoChunk = {
          kind: "video",
          id: `vid_${videoShareOrdinal}`,
          seq,
          mime: VIDEO_FRAME_MIME,
        };
        try {
          reportBadAck("video frame", await thread.sendVideo(chunk, bytes, false));
        } catch (error) {
          rememberError(error);
        }
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

      // ── the quick-config session layer (the K strip's scope model) ───────────
      // Sits ABOVE the persisted (localStorage) layer: DEFAULT ← tier preset ←
      // Vite intent ← persisted ← session. A digit in the strip writes only this
      // layer, so a quick tier switch lasts for the page session and a reload
      // returns to file + saved config; the strip's S folds it into the persisted
      // layer, R clears both. localStorage is read fresh on recompute — storage
      // is the single source of truth for the persisted layer.
      let sessionOverrides: Partial<IntentPipelineConfig> = {};
      // A tier picked while a thread is open: the thread's hello already told
      // the channel which pipeline to run, so the switch waits for thread-close.
      let pendingTier: IntentTier | undefined;
      const recomputeEffective = (): IntentPipelineConfig =>
        effectiveConfig(viteOption, { ...loadIntentOverrides(), ...sessionOverrides });
      const stripState = (note?: string): ConfigStripState => ({
        config,
        ...(pendingTier !== undefined ? { pendingTier } : {}),
        sessionDirty: Object.keys(sessionOverrides).length > 0,
        saved: Object.keys(loadIntentOverrides()).length > 0,
        ...(note !== undefined ? { note } : {}),
      });
      const applyTier = (tier: IntentTier): void => {
        sessionOverrides = { ...sessionOverrides, tier };
        pendingTier = undefined;
        applyEffective(recomputeEffective());
        strip.render(stripState());
        ctx.setStatus(`tier → ${tier} — this session only (K, then S to save)`);
      };

      // ── keymap: reuse the pure keyCommand, but own arming (rebind/disable) ────
      const dispatch = (command: KeyCommand): void => {
        switch (command.cmd) {
          case "config-toggle":
            if (strip.open) {
              strip.hide();
            } else {
              strip.show(stripState());
            }
            break;
          case "config-close":
            strip.hide();
            break;
          case "config-tier":
            if (engine.threadOpen) {
              pendingTier = command.tier;
              strip.render(stripState());
              ctx.setStatus(`tier → ${command.tier} — applies when this thread closes`);
            } else {
              applyTier(command.tier);
            }
            break;
          case "config-save": {
            // Fold everything explicit (persisted + session) into the persisted
            // layer — the same delta-vs-base the gear panel's Apply computes.
            saveIntentOverrides(overridesForApply({ ...config }, base));
            sessionOverrides = {};
            strip.render(stripState("saved for this site ✓"));
            ctx.setStatus("config saved for this site (browser storage)");
            break;
          }
          case "config-reset":
            clearIntentOverrides();
            sessionOverrides = {};
            pendingTier = undefined;
            applyEffective(effectiveConfig(viteOption, {}));
            strip.render(stripState("reset to the file config ✓"));
            ctx.setStatus("config reset to the file (Vite) config");
            break;
          case "config-advanced":
            strip.hide();
            ctx.openPanel();
            advancedPanel.open();
            break;
          case "arm-toggle":
            engine.setArmed(!engine.armed);
            break;
          case "talk-start":
            // Main-loop listening: the endpointer auto-splits the hold into
            // utterance segments (pseudo-streaming on the REST tier).
            mainListening = true;
            startEndpointer();
            void talkStart();
            break;
          case "talk-end":
            // Space released (possibly in the gap between auto-split segments
            // — the keymap sends this unconditionally): stop wanting to listen
            // FIRST so an in-flight silence-restart can't reopen the mic.
            mainListening = false;
            if (!listening()) {
              stopEndpointer();
            }
            void talkEnd();
            break;
          case "shoot-arm":
            // D pressed: arm the crosshair veil so the next drag is a region
            // shot. Only in ink mode — correct mode owns the pointer for text
            // selection, and shots belong to the ink layer.
            if (engine.mode === "ink") {
              shooting = true;
              shots.setArmed(true);
            }
            break;
          case "shoot-release":
            // D released: always disarm — this clears the veil even if the mode
            // flipped mid-hold (shoot-release keys off `shooting`, never the
            // mode, so the veil can't be stranded). setArmed(false) defers the
            // actual hide when a drag is still in flight so its pointerup can
            // finish the capture. There is deliberately NO viewport fallback
            // here: the whole-viewport shot is S's own key, split off so a fast
            // drag (pointerup before this keyup) can't also fire it.
            if (shooting) {
              shooting = false;
              shots.setArmed(false);
            }
            break;
          case "shoot-viewport":
            // S: capture the whole viewport now — a single press, no veil, no
            // hold. Gated on ink mode like the region shot.
            if (engine.mode === "ink") {
              void shots.shootViewport();
            }
            break;
          case "ink-clear":
            ink.clear();
            engine.inkCleared(false);
            break;
          case "correct-toggle":
            // The lasso→patch correction loop is a transcription-mode feature:
            // the realtime submode holds a live conversation with no editable
            // document to patch — the native fix there is just talking ("no, the
            // LEFT legend"). Gate at dispatch (needs the effective submode); the
            // keymap stays submode-agnostic.
            if (config.submode === "realtime") {
              ctx.setStatus(
                "corrections are a transcription-mode feature — in live mode just say the fix",
              );
              break;
            }
            engine.setMode(engine.mode === "correct" ? "ink" : "correct");
            break;
          case "video-toggle":
            // Screen share is realtime-only: the live model is what watches the
            // ~1 fps frames. Off a live tier, name the fix and do nothing else.
            if (config.submode !== "realtime") {
              ctx.setStatus("video needs a live tier — K, then 6/7");
              break;
            }
            void toggleVideoShare();
            break;
          case "send":
            engine.send();
            ink.clear();
            break;
          case "step-out":
            // In correct mode Esc aborts the whole edit session (every applied
            // diff undone) — same semantics as Esc inside either editor box.
            if (engine.mode === "correct") {
              preview.abortEdit();
              break;
            }
            if (engine.mode === "ink" && engine.threadOpen) {
              ink.clear();
            }
            engine.stepOut();
            break;
          case "swallow":
            break; // claimed key, no action (see the KeyCommand doc)
        }
        renderHud();
      };
      let uninstallKeys = bindKeys(
        config,
        () => engine,
        () => strip.open,
        dispatch,
      );

      // ── advanced config panel (gear → raw JSON over the full effective config) ─
      // Apply mutates the live config in place: dynamic reads (mock cadence, ink
      // fade, talk mode, transcriber/corrector) pick it up, engine.settings is
      // synced (autoEndSec, correctionPolicy, diffFlashMs the preview reads), the
      // keymap is rebound (arming key/enabled), and the labels refresh. The next
      // thread's hello carries the new config because openThread reads it fresh.
      const applyEffective = (effective: IntentPipelineConfig): void => {
        // Drop keys the new effective config no longer has (e.g. `tier` after a
        // reset) — Object.assign alone would leave them frozen on the live object.
        for (const key of Object.keys(config)) {
          if (!(key in effective)) {
            delete (config as unknown as Record<string, unknown>)[key];
          }
        }
        Object.assign(config, effective);
        Object.assign(engine.settings, effective);
        uninstallKeys();
        uninstallKeys = bindKeys(
          config,
          () => engine,
          () => strip.open,
          dispatch,
        );
        renderLabels();
        renderHud();
      };
      // The panel's Apply (and Reset) persists its own delta and hands back the
      // new effective config — at that point the session layer is folded in or
      // deliberately edited away, so it clears here (as does a pending tier).
      const advancedPanel = mountAdvancedConfig(container, {
        viteOption,
        effective: config,
        onApply: (effective) => {
          sessionOverrides = {};
          pendingTier = undefined;
          applyEffective(effective);
          if (strip.open) {
            strip.render(stripState());
          }
        },
      });

      // The agent's set_config: the SAME validate → delta → persist → applyEffective
      // path the advanced panel's Apply button runs (including the tier-switch
      // delta reconciliation, so switching `tier` re-derives that tier's fields),
      // so "agent, switch my tier to flagship" behaves exactly like editing the
      // JSON by hand.
      const applyConfigFromAgent = (raw: unknown): SetConfigResult => {
        const result = validateIntentConfig(raw);
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        const overrides = overridesForApply(result.config, base);
        saveIntentOverrides(overrides);
        // The agent set the persisted layer explicitly — the session layer (and
        // any tier waiting on thread-close) yields to it, like a panel Apply.
        sessionOverrides = {};
        pendingTier = undefined;
        const effective = effectiveConfig(viteOption, overrides);
        applyEffective(effective);
        if (strip.open) {
          strip.render(stripState());
        }
        overlayTools.reregister(); // schemas unchanged → invisible upstream, by design
        return { ok: true, applied: Object.keys(overrides).length, config: { ...effective } };
      };

      // The current thread's slice of the event log (from the last thread-open) —
      // the unit the turn store persists and the engine replays on recovery.
      const currentThreadEvents = (): IntentEvent[] => {
        for (let i = engine.events.length - 1; i >= 0; i--) {
          if (engine.events[i].type === "thread-open") {
            return engine.events.slice(i);
          }
        }
        return [];
      };

      // ── wire + lifecycle listener (preview & inspector subscribe separately) ─
      engine.onEvent((event) => {
        if (event.type === "thread-open") {
          openThreadSocket();
        }
        if (threadPromise && !merging) {
          outbox.push(event);
          scheduleFlush();
        }
        if (event.type === "thread-close") {
          if (event.reason === "send") {
            void finalizeThread();
          } else {
            void cancelThread();
          }
          // A tier picked mid-thread lands now — before any next thread opens,
          // so the next hello carries it.
          if (pendingTier !== undefined) {
            applyTier(pendingTier);
          }
        }
        // Persist the turn while a thread is open (transcript + shot refs + thread
        // state); a closed thread has nothing to recover.
        if (engine.threadOpen) {
          turn.record(currentThreadEvents(), true);
        } else {
          turn.clear();
        }
        renderHud();
      });
      renderHud();

      // ── the overlay's own agent surface (ns `aiui_overlay`) ──────────────────
      // The intent tool dogfoods the tool-surface methodology it enables: an
      // agent can inspect and reconfigure it mid-session like any instrumented
      // page. Installed here so it lives exactly as long as the widget does.
      const bridgePresent = (): boolean =>
        typeof window !== "undefined" && !!window.__AIUI__?.tools;
      const buildReport = (): OverlayReport => ({
        armed: engine.armed,
        mode: engine.mode,
        talking: engine.talking,
        threadOpen: engine.threadOpen,
        activeModality: ctx.activeModalityLabel(),
        panelOpen: ctx.panelOpen(),
        config: { ...config },
        events: {
          length: engine.events.length,
          last: engine.events.slice(-10).map((e) => ({ type: e.type, at: e.at })),
        },
        status: ctx.lastStatus(),
        channel: {
          port: ctx.port,
          threadSocket: threadState,
          bridge: bridgePresent() ? "present" : "absent",
        },
        selection: { present: ctx.selection() !== undefined },
        capture: { grant: shots.hasCaptureGrant() ? "granted" : "none" },
      });
      const overlayTools = installOverlayTools({
        report: buildReport,
        getConfig: () => ({ ...config }),
        setConfig: applyConfigFromAgent,
        arm: () => {
          engine.setArmed(true);
          renderHud();
        },
        disarm: () => {
          engine.setArmed(false);
          renderHud();
        },
        openPanel: () => ctx.openPanel(),
        closePanel: () => ctx.closePanel(),
        getEvents: (count) => engine.events.slice(-count),
      });

      // ── turn recovery: adopt an in-progress turn a remount/reload interrupted ─
      const recovered = turn.recover();
      if (recovered) {
        // Replay through listeners: the preview rebuilds and the modality re-opens
        // its socket and re-streams the log to a fresh thread (the old socket died
        // with the page). Shot pixels / audio don't survive — the refs do.
        engine.replay(recovered.events, { threadOpen: recovered.threadOpen });
        renderHud();
        if (config.submode === "realtime") {
          // A realtime turn's live session died with the page and can't be
          // revived — the channel opens a FRESH session on the new thread's
          // socket (so nothing crashes; the re-streamed events seed it). Say so:
          // the recovered dialogue is history, and any share must be re-toggled.
          ctx.setStatus(
            `recovered a live turn (${recovered.events.length} events) — its live session ended and a fresh one opens on send; ⏎ to send, Esc to discard`,
          );
        } else if (recovered.source === "reloaded") {
          ctx.setStatus(
            `recovered an in-progress turn (${recovered.events.length} events) — a reload interrupted its channel; ⏎ to send, Esc to discard`,
          );
        }
      }

      return {
        unmount() {
          overlayTools.dispose();
          uninstallKeys();
          undragHud();
          undragPreview();
          window.removeEventListener("blur", onWindowBlur);
          window.removeEventListener("focus", onWindowFocus);
          stopEndpointer();
          videoSampler.dispose();
          clearInterval(meterTimer);
          void cancelThread();
          ink.dispose();
          shots.dispose();
          preview.dispose();
          audio.dispose();
          pcmSource?.dispose();
          speechPlayer.dispose();
          layers.remove();
          style.remove();
          document.body.classList.remove("mm-armed");
        },
      };
    },
  };
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

/** The arming key as a short label for the HUD/help, honoring the config. */
function armKeyLabel(config: IntentPipelineConfig): string {
  if (config.arming?.enabled === false) {
    return "✳";
  }
  const key = config.arming?.key ?? "`";
  return key === "`" ? "`" : key;
}

/**
 * Bind the document keymap. Reuses the pure {@link keyCommand} + {@link
 * isTypingTarget} from the pipeline, but handles the **arming** key here so it
 * can be rebound or disabled per config (the pipeline's keyCommand hardcodes
 * backtick). Returns an uninstaller.
 */
function bindKeys(
  config: IntentPipelineConfig,
  getEngine: () => Engine,
  isConfigOpen: () => boolean,
  dispatch: (command: KeyCommand) => void,
): () => void {
  const armKey = config.arming?.key ?? "`";
  const armEnabled = config.arming?.enabled ?? true;
  const handler = (phase: "down" | "up") => (event: KeyboardEvent) => {
    if (isTypingTarget(event)) {
      return;
    }
    if (event.key === armKey) {
      if (armEnabled && phase === "down" && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        dispatch({ cmd: "arm-toggle" });
      }
      // Handled here (or intentionally inert) so keyCommand's backtick can't
      // double-fire against a rebind.
      return;
    }
    const engine = getEngine();
    const command = keyCommand(
      {
        armed: engine.armed,
        mode: engine.mode,
        talking: engine.talking,
        talkMode: config.talkMode,
        typing: false,
        configOpen: isConfigOpen(),
      },
      event.key,
      phase,
      event.repeat,
    );
    if (command && command.cmd !== "arm-toggle") {
      event.preventDefault();
      event.stopPropagation();
      if (!(command.cmd === "talk-start" && engine.talking)) {
        dispatch(command);
      }
    }
  };
  const down = handler("down");
  const up = handler("up");
  document.addEventListener("keydown", down, true);
  document.addEventListener("keyup", up, true);
  return () => {
    document.removeEventListener("keydown", down, true);
    document.removeEventListener("keyup", up, true);
  };
}
