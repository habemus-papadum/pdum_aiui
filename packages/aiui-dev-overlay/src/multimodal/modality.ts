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
 *  - the page selection rides the stream itself as an `app-selection` event,
 *    emitted right after thread-open (whatever was highlighted before arming —
 *    the engine reads the watcher's snapshot via its selection provider) and
 *    re-emitted on mid-turn changes; the legacy `chunk{kind:"context"}` frame
 *    is no longer sent (the server still accepts it from older clients);
 *  - the server lowers and pushes echoes back — a segment's `transcript-final`,
 *    a completed `correction` — which merge into the engine stream as if local.
 *
 * Everything degrades: no channel port / an old server that refuses the format →
 * composing still works locally and the send reports the error; no mic → talk
 * is inert with a hint; no capture grant → shots carry the rect + components,
 * no pixels.
 *
 * The plumbing thirds live under `./shell` (proposal B2.4) — `wire.ts` (the
 * thread socket + merge + correction round-trip), `talk.ts` (the mic lanes +
 * silence endpointer), `capture.ts` (shots + the screen share) — all
 * framework-free, each owning its own state. This file is their only
 * composer: mount orchestration, the HUD content, the uiMode/reconciler
 * surfaces, the one dispatch switch (now pure routing), the keymap, the
 * session-bus host role, turn recovery, and unmount.
 */

import { createReconciler } from "@habemus-papadum/aiui-viz/modal";
import { makeDraggable } from "../drag";
import { getInstrumentation, type RemotePaintSink } from "../instrumentation";
import type { IntentModality, IntentToolContext } from "../intent";
import { toAppSelection } from "../intent";
import {
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
import { SESSION_CONTRIBUTION_TOPIC, type SessionContribution } from "../session-contrib";
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
import { type PcmSource, WorkletPcmSource } from "./audio";
import { ConfigStrip, type ConfigStripState } from "./config-strip";
import { Ink } from "./ink";
import { Preview } from "./preview";
import { createCapture } from "./shell/capture";
import { createTalk } from "./shell/talk";
import { createWire } from "./shell/wire";
import { type SpeechAudioFactory, SpeechPlayer } from "./speech";
import { HUD_STYLES, STYLES } from "./styles";
import { UI_MODE_TABLE, type UiMode, uiMode } from "./ui-mode";

/** A code selection's excerpt in the mirror marker — one glanceable line. */
const CODE_EXCERPT_CHARS = 48;

/** Collapse a code selection to a one-line, length-capped marker excerpt. */
function codeExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CODE_EXCERPT_CHARS ? `${flat.slice(0, CODE_EXCERPT_CHARS)}…` : flat;
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
      // The turn's app selection. At thread-open the engine reads the host's
      // selection watcher through this provider, so whatever was highlighted
      // on the page BEFORE arming opens the turn as its `app-selection` event
      // (the transcript begins with the selection chip, and the selection can
      // never be lost to a send-time read). Mid-turn changes keep the event
      // current (last wins); a cleared watcher (the panel chip's ✕) retracts it.
      engine.selectionProvider = () => {
        const snap = ctx.selection();
        return snap !== undefined ? toAppSelection(snap) : undefined;
      };
      const offSelectionChange = ctx.onSelectionChange((snap) => {
        if (!engine.threadOpen) {
          return; // an app selection is context riding a turn, never a turn opener
        }
        if (snap !== undefined) {
          engine.appSelection(toAppSelection(snap));
        } else {
          engine.appSelectionDrop();
        }
      });
      // The durable turn store: survives a soft remount in memory, and mirrors
      // to sessionStorage so a full reload (an overlay-source edit under the dev
      // server — see turn-store.ts) can still recover the in-progress turn.
      const turn = intentTurnStore();

      // The session bus (installed by the Vite plugin's mount module, or app
      // code): this modality is the turn HOST — it publishes `armed` + a prompt
      // `preview` to the session's other views (the code reader) and ingests
      // their `contribution`s. Undefined without a bus (manual mount / no
      // channel): the turn just works locally, exactly as before.
      const bus = typeof window !== "undefined" ? window.__AIUI__?.session : undefined;
      // Guards the arming feedback loop: while applying a remote arm we must not
      // re-broadcast it (the emitted `armed` event would echo back out).
      let applyingRemoteArm = false;

      // ── the shell thirds (see ./shell): framework-free plumbing, composed
      // here and nowhere else. The wire owns the thread socket; `config` is
      // mutated in place by applyEffective (below), so it crosses every seam
      // as a thunk. `speechPlayer` is created further down (its label renders
      // into the HUD slot); server pushes only arrive post-mount, so the
      // deferred thunk is safe.
      const wire = createWire({
        engine,
        config: () => config,
        openThread: (options) => ctx.openThread(options),
        setStatus: (text) => ctx.setStatus(text),
        reportError: (error) => ctx.reportError(error),
        clearSelection: () => ctx.clearSelection(),
        enqueueSpeech: (clip) => speechPlayer.enqueue(clip),
      });
      // The correction micro-pipeline (mock local / channel round-trip) lives
      // on the wire — its channel leg is a wire round-trip (see shell/wire.ts).
      engine.correctionPipeline = wire.correctionPipeline;

      // ── page-level interaction layers (light DOM: native selection must
      // resolve against the preview text, per field-notes) ────────────────────
      const style = document.createElement("style");
      style.textContent = STYLES;
      document.head.append(style);

      const layers = document.createElement("div");
      layers.className = "mm-layers";

      const ink = new Ink({
        fadeSec: () => config.inkFadeSec,
        onStroke: (points, bounds) => engine.strokeDone(points, bounds),
        onAutoClear: () => engine.inkCleared(true),
      });
      layers.append(ink.canvas);

      // ── remote-paint seam ────────────────────────────────────────────────────
      // Publish an ink sink on window.__AIUI__ so an external controller (the
      // aiui-paint host, driving strokes from an iPad) can arm this intent tool
      // and inject strokes into the SAME ink layer local drawing uses — so a
      // circle drawn on the iPad composites into a shot and joins the turn just
      // like a local one. `renderHud` (below) is a hoisted declaration; the sink
      // only fires post-mount.
      const remotePaint: RemotePaintSink = {
        setArmed(on) {
          engine.setArmed(on);
          if (on && engine.mode !== "ink") {
            engine.setMode("ink");
          }
          renderHud();
        },
        beginStroke(id, style, point) {
          if (engine.armed) {
            ink.remoteBegin(id, style, point.x, point.y);
          }
        },
        extendStroke(id, point) {
          ink.remotePoint(id, point.x, point.y);
        },
        endStroke(id, point) {
          ink.remoteEnd(id, point?.x, point?.y);
        },
        cancelStroke(id) {
          ink.remoteCancel(id);
        },
        size: () => ({ width: window.innerWidth, height: window.innerHeight }),
      };
      const instrumentation = getInstrumentation();
      if (instrumentation) {
        instrumentation.remotePaint = remotePaint;
      }

      // The capture owners (shot tool + the realtime screen sampler) live in
      // shell/capture.ts; the veil joins the page layers here, in the same
      // stacking position as before. `renderHud` is a hoisted declaration
      // below — the share paths that call it only run post-mount.
      const capture = createCapture({
        engine,
        ink,
        uploadAttachment: wire.uploadAttachment,
        uploadVideo: wire.uploadVideo,
        setStatus: (text) => ctx.setStatus(text),
        reportError: (error) => ctx.reportError(error),
        renderHud: () => renderHud(),
        ...(deps.videoSampleIntervalMs !== undefined
          ? { videoSampleIntervalMs: deps.videoSampleIntervalMs }
          : {}),
      });
      layers.append(capture.veil);

      // The talk lanes (REST + PCM) and the silence endpointer live in
      // shell/talk.ts. `speechPlayer` is created below — talk only starts on
      // user interaction, post-mount, so the barge-in thunk is safe.
      const talk = createTalk({
        engine,
        config: () => config,
        pcmSource: deps.pcmSource ?? (() => new WorkletPcmSource()),
        setStatus: (text) => ctx.setStatus(text),
        reportError: (error) => ctx.reportError(error),
        bargeIn: () => speechPlayer.bargeIn(),
        getThread: wire.getThread,
        flushOutbox: wire.flushOutbox,
        uploadAttachment: wire.uploadAttachment,
        uploadAudio: wire.uploadAudio,
      });

      // The preview borrows the talk plumbing for the correction bar: the mic
      // goes live hands-free while the bar is open, streamed speech renders in
      // its live zone, and Enter ends the segment before committing. The hooks
      // live in shell/talk.ts and only fire on user interaction, post-mount.
      const preview = new Preview(engine, {
        start: talk.startCorrectionListening,
        stop: talk.stopCorrectionListening,
        talking: () => engine.talking,
        heard: talk.heardVoice,
      });
      layers.append(preview.root);

      // ── HUD (arm button + state + level meter) — the widget pill's slot ──────
      // The §B.4 merge: the HUD is no longer its own floating surface; it IS
      // the left section of the intent widget's pill, riding the pill's drag,
      // mode ring, and shadow-root style isolation (hence addStyle — page
      // sheets can't reach the slot). The old key-cheat-sheet span retired
      // into the panel help, which always carried the same text: it was the
      // pill's noisiest tenant.
      const hudSlot = ctx.hudSlot();
      hudSlot.addStyle(HUD_STYLES);
      const hud = document.createElement("div");
      hud.className = "mm-hud";
      hud.innerHTML = `
        <button class="mm-arm" title="arm/disarm">✳</button>
        <span class="mm-state">off</span>
        <span class="mm-video" hidden>● video</span>
        <canvas class="mm-meter" width="60" height="14"></canvas>
        <span class="mm-speaker" hidden></span>`;
      hudSlot.container.append(hud);

      // The quick-config strip (the K layer) sits just above the HUD. Clicks
      // on its chips/actions route into the same dispatch as the keymap
      // (`dispatch` is defined below; strip clicks can only happen post-mount).
      const strip = new ConfigStrip((command) => dispatch(command));
      layers.append(strip.root);
      document.body.append(layers);
      // Selections inside our own page-level layers are gestures (the
      // correct-mode lasso in the preview body), never the "app selection" —
      // without this, lassoing a transcript span silently REPLACED the
      // watcher's snapshot of what the user had highlighted in the app.
      ctx.ignoreSelectionsWithin(layers);

      // The preview moves out of the way by dragging (it covers app content by
      // construction) — but only by its frame/title: inside the transcript
      // body a drag *is* the correction-targeting selection gesture, and the
      // correction bar holds an input — both stay excluded. (The HUD rides
      // the widget pill's drag now — one anchor, one grip.)
      const undragPreview = makeDraggable(preview.root, {
        exclude: (target) => target.closest(".mm-preview-body, .mm-correction-bar") !== null,
      });
      const armButton = hud.querySelector<HTMLButtonElement>(".mm-arm");
      const stateLabel = hud.querySelector<HTMLSpanElement>(".mm-state");
      const videoBadge = hud.querySelector<HTMLSpanElement>(".mm-video");
      const meter = hud.querySelector<HTMLCanvasElement>(".mm-meter");
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
          The ✳ pill shows the live state while active.`;
      };
      renderLabels();

      /** The one derived answer to "what mode am I in" (ui-mode.ts). */
      const currentUiMode = (): UiMode =>
        uiMode({
          armed: engine.armed,
          mode: engine.mode,
          talking: engine.talking,
          threadOpen: engine.threadOpen,
          shooting: capture.shooting(),
        });

      // The invariant half of the old renderHud, as kit reconciler surfaces:
      // asserted from state after EVERY dispatch and engine event, never
      // toggled at transitions — one missed transition costs a frame, not a
      // wedged UI. Two passes because the guards may clear `shooting`, and
      // the UiMode the surface pass renders must be computed after they run.
      const enforceGuards = createReconciler<UiMode>([
        {
          // "No armed+ink state → no veil." The veil is stranded when D's
          // keyup never arrives — classically the first shot's
          // getDisplayMedia picker stealing focus mid-hold — and a stranded
          // veil is a full-viewport crosshair overlay the user can't click
          // through, surviving disarm.
          name: "shot-veil",
          apply: () => {
            if (capture.shooting() && (!engine.armed || engine.mode !== "ink")) {
              capture.cancelShot();
            }
          },
        },
        {
          // The screen share is bounded by the turn: it can't outlive the
          // thread (send/cancel/timeout) or a disarm.
          name: "video-share",
          apply: () => {
            if (capture.sharing() && (!engine.armed || !engine.threadOpen)) {
              capture.stopShare();
            }
          },
        },
      ]);
      const enforceSurfaces = createReconciler<UiMode>([
        {
          // Disarming always closes the quick-config strip (a layer, not a
          // mode — so it isn't in the mode table; it just can't outlive arm).
          name: "config-strip",
          apply: (mode) => {
            if (mode === "off") {
              strip.hide();
            }
          },
        },
        {
          // Cursors are part of the mode contract: the crosshair comes from
          // the mode table's cursor column, not from scattered toggles.
          name: "cursor",
          apply: (mode) => {
            document.body.classList.toggle(
              "mm-armed",
              UI_MODE_TABLE.modes[mode].cursor === "crosshair",
            );
          },
        },
        {
          // The mode ring (§B.4): the widget pill's data-ui-mode drives the
          // border color, one peripheral signal for the whole table. The
          // armed/talking classes stay as raw-state hooks on the slot content
          // (the ✳ fill, the meter tint).
          name: "mode-ring",
          apply: (mode) => {
            ctx.setUiMode(mode === "off" ? undefined : mode);
            hud.classList.toggle("armed", engine.armed);
            hud.classList.toggle("talking", engine.talking);
          },
        },
        {
          // Ink owns the pointer exactly while composing-shaped (ink mode, no
          // veil): ready/composing/talking — you can keep sketching mid-REC.
          name: "ink-routing",
          apply: (mode) => {
            ink.setActive(mode === "ready" || mode === "composing" || mode === "talking");
          },
        },
        {
          name: "preview",
          apply: (mode) => {
            preview.setCorrectMode(mode === "correcting");
            preview.root.classList.toggle("visible", mode !== "off");
          },
        },
      ]);

      function renderHud(): void {
        enforceGuards(currentUiMode());
        const mode = currentUiMode();
        enforceSurfaces(mode);
        if (stateLabel) {
          stateLabel.textContent = !engine.armed
            ? "off"
            : `${engine.mode}${engine.talking ? " · REC" : ""}${engine.threadOpen ? " · thread" : ""}`;
        }
        if (videoBadge) {
          videoBadge.hidden = !capture.sharing();
        }
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
        if (capture.shooting()) {
          capture.cancelShot();
        }
        if (talk.listening() || engine.talking) {
          talk.stopAllListening();
        }
        // A screen share PAUSES on blur (rather than ending): the user glanced
        // away, and streaming the other window they turned to would be both
        // wrong context and wasted frames. Refocus resumes it (onWindowFocus)
        // if the share is still on — pause/resume is a no-op when not sharing.
        capture.pauseShare();
      };
      const onWindowFocus = (): void => {
        if (engine.armed && engine.mode === "correct" && !engine.talking) {
          talk.startCorrectionListening();
        }
        capture.resumeShare();
      };
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);

      const meterCtx = meter?.getContext("2d") ?? null;
      const meterTimer = setInterval(() => {
        if (!meterCtx || !meter) {
          return;
        }
        meterCtx.clearRect(0, 0, meter.width, meter.height);
        const level = engine.talking ? talk.level() : 0;
        meterCtx.fillStyle = engine.talking ? "#ff5c87" : "#3a4152";
        meterCtx.fillRect(0, 0, Math.max(2, level * meter.width), meter.height);
      }, 80);

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
            // Main-loop listening (the endpointer auto-splits — shell/talk.ts).
            talk.startMainListening();
            break;
          case "talk-end":
            talk.stopMainListening();
            break;
          case "shoot-arm":
            capture.armShot();
            break;
          case "shoot-release":
            capture.releaseShot();
            break;
          case "shoot-viewport":
            capture.shootViewport();
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
            void capture.toggleVideoShare();
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

      // The prompt-so-far, broadcast to the session's other views so the code
      // reader can mirror it (read-only). Deduped — only a real text change is
      // worth a bus message.
      let lastPreview = "";
      const broadcastPreview = (): void => {
        if (!bus) {
          return;
        }
        const text = engine.threadOpen
          ? composeIntent(currentThreadEvents(), config.correctionPolicy)
              .items.filter((i) => i.kind === "text" || i.kind === "code-selection")
              .map((i) =>
                // The reader's mirror is plain text: a contributed code
                // selection shows as a compact marker — location plus a
                // clipped excerpt (a bare locator is opaque when debugging),
                // not its full rendering.
                i.kind === "code-selection"
                  ? `[code: ${i.sourceLoc ?? "selection"} “${codeExcerpt(i.text ?? "")}”]`
                  : (i.text ?? ""),
              )
              .join(" ")
              .trim()
          : "";
        if (text === lastPreview) {
          return;
        }
        lastPreview = text;
        bus.set("preview", { text, threadOpen: engine.threadOpen, armed: engine.armed });
      };

      // ── wire + lifecycle listener (preview & inspector subscribe separately) ─
      engine.onEvent((event) => {
        // thread-open opens the socket; everything queues on the debounce
        // while a socket exists and we're not merging an echo (shell/wire.ts).
        wire.onEngineEvent(event);
        // Mirror local arming to the session bus (unless we're applying a remote
        // arm — that would echo back out and ping-pong).
        if (event.type === "armed" && bus && !applyingRemoteArm) {
          bus.set("armed", event.on);
        }
        if (event.type === "thread-close") {
          if (event.reason === "send") {
            void wire.finalizeThread();
          } else {
            void wire.cancelThread();
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
        broadcastPreview();
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
        // The derived §B.4 mode — the ONE answer to "what mode am I in",
        // shared with the HUD ring and the reconciler surfaces.
        uiMode: currentUiMode(),
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
          threadSocket: wire.socketState(),
          bridge: bridgePresent() ? "present" : "absent",
        },
        selection: { present: ctx.selection() !== undefined },
        capture: { grant: capture.hasCaptureGrant() ? "granted" : "none" },
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

      // ── session bus: this modality hosts the shared turn ─────────────────────
      // Apply a remote arm (from the reader's toggle), ingest contributions (a
      // code selection → turn text), and publish the current state once the bus
      // is ready so a view that connected first catches up.
      let disposeBus: (() => void) | undefined;
      if (bus) {
        const offArmed = bus.on("armed", (value) => {
          if (typeof value !== "boolean" || value === engine.armed) {
            return;
          }
          applyingRemoteArm = true;
          engine.setArmed(value);
          applyingRemoteArm = false;
          renderHud();
        });
        const offContrib = bus.onPublish(SESSION_CONTRIBUTION_TOPIC, (payload) => {
          const c = payload as SessionContribution | undefined;
          if (!c || typeof c.text !== "string" || c.text.length === 0) {
            return;
          }
          // A contribution implies intent: arm if the session isn't already.
          if (!engine.armed) {
            engine.setArmed(true);
          }
          if (c.kind === "selection") {
            // Structured, not pre-rendered: the code-selection event shows as
            // a chip in the preview and composeIntent decides how it reads in
            // the prompt at lowering time (see session-contrib.ts).
            engine.codeSelection({
              text: c.text,
              ...(c.sourceLoc !== undefined ? { sourceLoc: c.sourceLoc } : {}),
              ...(c.url !== undefined ? { url: c.url } : {}),
              ...(c.lines !== undefined ? { lines: c.lines } : {}),
            });
          } else {
            engine.contribute(c.text);
          }
          renderHud();
          broadcastPreview();
          ctx.setStatus(
            c.kind === "selection"
              ? "added a code selection to the turn"
              : "added a note to the turn",
          );
        });
        const offReady = bus.onReady(() => {
          bus.set("armed", engine.armed);
          broadcastPreview();
        });
        disposeBus = () => {
          offArmed();
          offContrib();
          offReady();
        };
      }

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
          offSelectionChange();
          if (instrumentation?.remotePaint === remotePaint) {
            instrumentation.remotePaint = undefined;
          }
          disposeBus?.();
          overlayTools.dispose();
          uninstallKeys();
          undragPreview();
          window.removeEventListener("blur", onWindowBlur);
          window.removeEventListener("focus", onWindowFocus);
          talk.dispose(); // endpointer + both mic lanes
          capture.dispose(); // video sampler + shot tool
          clearInterval(meterTimer);
          wire.dispose(); // cancels any open thread socket
          ink.dispose();
          preview.dispose();
          speechPlayer.dispose();
          hud.remove();
          ctx.setUiMode(undefined);
          layers.remove();
          style.remove();
          document.body.classList.remove("mm-armed");
        },
      };
    },
  };
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
