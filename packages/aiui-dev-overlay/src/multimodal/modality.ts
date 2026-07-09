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
 *  - page selections ride the stream itself as positional `app-selection`
 *    events (marker `sel_N`, like a shot's `shot_N`): one right after
 *    thread-open (whatever was highlighted before arming — the engine reads
 *    the watcher's snapshot via its selection provider), and one per mid-turn
 *    selection; refinements with nothing contentful in between supersede
 *    under the same marker (one chip tracking a drag), and each chip's ✕
 *    streams an `app-selection-drop` for exactly that marker. The legacy
 *    `chunk{kind:"context"}` frame is no longer sent (the server still
 *    accepts it from older clients);
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

import { blurExitTarget, createReconciler, type KeyHint } from "@habemus-papadum/aiui-viz/modal";
import { makeDraggable } from "../drag";
import { getInstrumentation, type RemotePaintSink } from "../instrumentation";
import type { IntentModality, IntentToolContext } from "../intent";
import { toAppSelection } from "../intent";
import {
  composeIntent,
  Engine,
  engineOf,
  type IntentEvent,
  type IntentPipelineConfig,
  intentKeyHints,
  isTypingTarget,
  type KeyCommand,
  keyCommand,
  keymapHelp,
  TRANSCRIPTION_ENGINES,
} from "../intent-pipeline";
import { installOverlayTools, type OverlayReport, type SetConfigResult } from "../overlay-tools";
import {
  type PreviewItem,
  type PreviewSnapshot,
  SESSION_CONTRIBUTION_TOPIC,
  type SessionContribution,
} from "../session-contrib";
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
import { JumpPicker } from "./jump-picker";
import { CHEAT_STYLES, CheatSheet, KEYMAP_HELP_STYLES, KeymapHelp } from "./keymap-ui";
import { Preview } from "./preview";
import { createCapture } from "./shell/capture";
import { createTalk } from "./shell/talk";
import { createWire } from "./shell/wire";
import { type SpeechAudioFactory, SpeechPlayer } from "./speech";
import { HUD_STYLES, STYLES } from "./styles";
import { UI_MODE_TABLE, type UiMode, uiMode } from "./ui-mode";
import { jumpTargets } from "./vscode";

/** A selection's excerpt in the mirror item — one glanceable line. */
const CODE_EXCERPT_CHARS = 48;

/** Collapse a selection to a one-line, length-capped mirror excerpt. */
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
  /**
   * How a vscode-mode jump navigates to its `vscode://` deep link; defaults
   * to `window.location.assign`. Injected in jsdom, which can't navigate.
   */
  navigate?: (url: string) => void;
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
      // The turn's opening app selection. At thread-open the engine reads the
      // host's selection watcher through this provider, so whatever was
      // highlighted on the page BEFORE arming opens the turn as its first
      // `app-selection` event (the transcript begins with the selection chip,
      // and the selection can never be lost to a send-time read). Each later
      // watcher snapshot appends its own positional event — the engine's
      // marker/supersede rule keeps a refined drag on one chip — and a
      // cleared watcher (the panel chip's ✕) retracts the latest.
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
      // `preview` to the session's other views and ingests
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
        // The live cadence (the fps slider writes videoFrameIntervalMs; the
        // sampler re-reads this thunk before every tick).
        videoFrameIntervalMs: () => config.videoFrameIntervalMs ?? 5000,
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

      const preview = new Preview(engine);
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
        <input class="mm-fps" type="range" min="0" max="4" step="1" hidden
          title="frame cadence" />
        <canvas class="mm-meter" width="60" height="14"></canvas>
        <span class="mm-speaker" hidden></span>`;
      hudSlot.container.append(hud);

      // The quick-config strip (the K layer) sits just above the HUD. Clicks
      // on its chips/actions route into the same dispatch as the keymap
      // (`dispatch` is defined below; strip clicks can only happen post-mount).
      const strip = new ConfigStrip((command) => dispatch(command));
      layers.append(strip.root);
      // The jump picker (vscode mode's double-click popup) and its on-page
      // bounding-box highlight — same dispatch-routing shape as the strip.
      const picker = new JumpPicker((command) => dispatch(command));
      layers.append(picker.root, picker.highlight);
      // The always-present condensed cheat sheet (renderHud re-asserts it
      // from the live keymap rows — see keymap-ui.tsx). It mounts in the
      // widget's BELOW-PILL slot: under the pill, inside the draggable
      // bottom-anchored root — so showing it slides the pill up, and it
      // follows the pill wherever it's dragged. Tapping a cap synthesizes
      // its key through the SAME pure resolver a keydown uses (the kit's
      // tapKey pattern), so a click can never drift from what the key does.
      // The down→up fallback makes hold-gesture keys click-toggles: tapping
      // 🎙 while talking resolves the down to "swallow", so the up's
      // talk-end runs instead.
      const tapKey = (key: string): void => {
        if (key === (config.arming?.key ?? "`") || key === "`") {
          dispatch({ cmd: "arm-toggle" });
          return;
        }
        const state = {
          armed: engine.armed,
          mode: engine.mode,
          talking: engine.talking,
          talkMode: config.talkMode,
          typing: false,
          configOpen: strip.open,
          pickerOpen: picker.open,
        };
        const down = keyCommand(state, key, "down", false);
        if (down !== undefined && down.cmd !== "swallow") {
          dispatch(down);
          return;
        }
        const up = keyCommand(state, key, "up", false);
        if (up !== undefined && up.cmd !== "swallow") {
          dispatch(up);
        }
      };
      hudSlot.addStyle(CHEAT_STYLES);
      const cheat = new CheatSheet(tapKey);
      hudSlot.below.append(cheat.root);
      // How a committed jump navigates (injected in jsdom, which can't).
      const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));
      document.body.append(layers);
      // Selections inside our own page-level layers are gestures (the
      // correct-mode lasso in the preview body), never the "app selection" —
      // without this, lassoing a transcript span silently REPLACED the
      // watcher's snapshot of what the user had highlighted in the app.
      ctx.ignoreSelectionsWithin(layers);

      // The preview moves out of the way by dragging (it covers app content by
      // construction) — but only by its frame/title: inside the transcript
      // body a drag selects text the reader may want to copy — it stays
      // excluded. (The HUD rides the widget pill's drag now — one anchor,
      // one grip.)
      const undragPreview = makeDraggable(preview.root, {
        exclude: (target) => target.closest(".mm-preview-body") !== null,
      });
      const armButton = hud.querySelector<HTMLButtonElement>(".mm-arm");
      const stateLabel = hud.querySelector<HTMLSpanElement>(".mm-state");
      const videoBadge = hud.querySelector<HTMLSpanElement>(".mm-video");
      // The share's cadence slider: five steps over the useful range. Writes
      // the SESSION layer (like a tier digit) — the sampler's thunk reads the
      // effective config before each tick, so it applies mid-share.
      const FPS_STEPS = [500, 1000, 2000, 5000, 10000] as const;
      const fpsSlider = hud.querySelector<HTMLInputElement>(".mm-fps");
      const fpsLabel = (ms: number): string =>
        ms >= 1000 ? `1 frame / ${ms / 1000}s` : `${1000 / ms} frames/s`;
      fpsSlider?.addEventListener("input", () => {
        const ms = FPS_STEPS[Number(fpsSlider.value)] ?? 5000;
        sessionOverrides = { ...sessionOverrides, videoFrameIntervalMs: ms };
        applyEffective(recomputeEffective());
        fpsSlider.title = fpsLabel(ms);
        ctx.setStatus(`video cadence → ${fpsLabel(ms)} (session only)`);
      });
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

      // ── the panel body: the keymap, as a table (H / the pill's ? toggles) ────
      // Generated from the SAME binding rows the resolver reads (keymapHelp),
      // so the help can't drift from the keys. Re-rendered on an
      // advanced-config apply — the arm key may be rebound, talk mode may flip.
      hudSlot.addStyle(KEYMAP_HELP_STYLES);
      const helpUi = new KeymapHelp();
      container.append(helpUi.root);
      // The arm layer displays backtick; honor a rebound (or disabled → ✳
      // button-only) arming key wherever its row shows.
      const armHintKey = (hints: KeyHint[]): KeyHint[] =>
        hints.map((h) => (h.key === "`" ? { ...h, key: armKeyLabel(config) } : h));
      const renderLabels = (): void => {
        helpUi.render(
          keymapHelp(config.talkMode).map((section) => ({
            ...section,
            hints: armHintKey(section.hints),
          })),
        );
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
          // The jump picker can't outlive its context: it opens from jump
          // mode's double-click OR the armed shift-click (any mode but
          // tweak), so the guard hides it only where neither gesture is
          // live — disarmed, or the tweak handover. Asserted from state
          // like every surface here, never toggled at transitions.
          name: "jump-picker",
          apply: (mode) => {
            if (mode === "off" || mode === "tweaking") {
              picker.hide();
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
            preview.root.classList.toggle("visible", mode !== "off");
          },
        },
      ]);

      function renderHud(): void {
        enforceGuards(currentUiMode());
        const mode = currentUiMode();
        enforceSurfaces(mode);
        if (stateLabel) {
          // The active backends ride the state label while armed — which
          // transcriber (its engine icon) and which linter, at a glance;
          // hover for the full names.
          const activeEngine = engineOf(config);
          const linter = config.linter ?? "off";
          const backends = !engine.armed
            ? ""
            : ` · ${activeEngine?.icon ?? "?"}${linter !== "off" ? ` 💡${linter}` : ""}`;
          stateLabel.textContent = !engine.armed
            ? "off"
            : `${engine.mode}${engine.talking ? " · REC" : ""}${engine.threadOpen ? " · thread" : ""}${backends}`;
          stateLabel.title = !engine.armed
            ? ""
            : `transcriber: ${activeEngine?.label ?? config.transcriber} (${activeEngine?.shape ?? "?"}) · linter: ${linter}`;
        }
        if (videoBadge) {
          videoBadge.hidden = !capture.sharing();
        }
        if (fpsSlider) {
          fpsSlider.hidden = !capture.sharing();
          if (!fpsSlider.matches(":active")) {
            const ms = config.videoFrameIntervalMs ?? 5000;
            const step = FPS_STEPS.findIndex((v) => v >= ms);
            fpsSlider.value = String(step === -1 ? FPS_STEPS.length - 1 : step);
            fpsSlider.title = fpsLabel(ms);
          }
        }
        if (meter) {
          meter.hidden = !engine.armed; // an idle meter is just a gap in the pill
        }
        // The condensed cheat sheet: the CURRENT state's live keymap rows,
        // hidden while disarmed (the pill's ? teaches the off state) and
        // while the config strip is open (it displays its own bindings).
        const hints = intentKeyHints({
          armed: engine.armed,
          mode: engine.mode,
          talking: engine.talking,
          talkMode: config.talkMode,
          typing: false,
          configOpen: strip.open,
          pickerOpen: picker.open,
        });
        // Ink's drag gesture is pointer-side, not a key — give it a row
        // whenever ink owns the pointer.
        if (mode === "ready" || mode === "composing" || mode === "talking") {
          hints.splice(1, 0, { key: "drag", label: "sketch ink", icon: "✏️" });
        }
        cheat.update(armHintKey(hints), engine.armed && !strip.open);
      }

      // A focus steal mid-D-hold (the display-capture picker, a cmd-tab) eats
      // the keyup itself: treat window blur as D-up. setArmed(false) already
      // defers the hide when a drag is genuinely in flight.
      //
      // Blur also STOPS LISTENING. A mic left open on another window once
      // transcribed an entire spoken conversation, segment by segment, on the
      // API bill. Away = mic off (the open window commits, never discards).
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
        // A mode that exists to take you OUT of the page must not survive the
        // excursion: vscode mode's jump lands in the editor (blurring this
        // window), and returning to the tab must resume composing, not a
        // forgotten double-click trap. Declared per-mode in the mode table
        // (blurExits) and resolved by the kit — never hand-patched per mode;
        // stepOut is the same one-level transition the column's target names.
        const mode = currentUiMode();
        if (blurExitTarget(UI_MODE_TABLE, mode) !== null) {
          engine.stepOut();
          ctx.setStatus(`${mode} mode ended — the jump left this window`);
        }
      };
      const onWindowFocus = (): void => {
        capture.resumeShare();
      };
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);

      // ── VS Code jump mode: double-click → the jump picker ────────────────────
      // Active only while the engine is in vscode mode (J). Capture-phase, and
      // the gesture is claimed wholesale (preventDefault/stopPropagation) — in
      // this mode a double-click means "show me where this can jump", never
      // whatever the app would do with it; single clicks still belong to the
      // page, exactly like tweak mode. The click doesn't navigate: it opens
      // the picker over ./vscode.ts's two chains (stamped element ancestors +
      // containing cells at their definition sites), nearest element
      // preselected, and the commit happens in dispatch (jump-commit below).
      // An unstamped click still opens the picker — which NAMES the miss —
      // so "nothing happened" is never ambiguous with "no source location".
      const widgetRoot = hudSlot.container.getRootNode();
      const widgetHost = widgetRoot instanceof ShadowRoot ? widgetRoot.host : undefined;
      const isOurSurface = (el: Element): boolean =>
        layers.contains(el) || widgetHost?.contains(el) === true;
      // Which element did the user MEAN? Not always `event.target`: while ink
      // owns the pointer its canvas is a full-viewport layer (`inset: 0`,
      // pointer-events auto), so every armed ink-mode click targets the canvas
      // and never the app beneath. The pen layer is the one surface of ours
      // that inspection sees THROUGH — look under it. Everything else we own
      // (widget, picker, strip, preview, shot veil) stacks above the canvas
      // and is real UI: it absorbs the gesture, and the picker stays shut.
      const appElementAt = (event: MouseEvent): Element | null => {
        const target = event.target instanceof Element ? event.target : null;
        if (target !== ink.canvas) {
          return target !== null && !isOurSurface(target) ? target : null;
        }
        // jsdom has no hit-testing (and no elementsFromPoint): degrade to
        // "the pen layer swallowed it", never to a wrong element.
        const beneath =
          typeof document.elementsFromPoint === "function"
            ? document.elementsFromPoint(event.clientX, event.clientY)
            : [];
        return beneath.find((el) => !isOurSurface(el)) ?? null;
      };
      const openPickerAt = (event: MouseEvent): void => {
        const target = appElementAt(event);
        if (target === null) {
          return; // our own surfaces are not the app
        }
        event.preventDefault();
        event.stopPropagation();
        picker.openAt(jumpTargets(target, window.__AIUI__?.sourceRoot), {
          x: event.clientX,
          y: event.clientY,
        });
      };
      const onDblClick = (event: MouseEvent): void => {
        if (!engine.armed || engine.mode !== "vscode") {
          return;
        }
        openPickerAt(event);
      };
      document.addEventListener("dblclick", onDblClick, true);
      // ⇧-click: the jump picker WITHOUT entering jump mode — armed, any mode
      // but tweak (tweak hands the whole pointer to the page on purpose).
      // Shift is the inspect modifier throughout: the ink layer ignores
      // shift-drags so the gesture never leaves a stroke behind.
      const onShiftClick = (event: MouseEvent): void => {
        if (!engine.armed || engine.mode === "tweak" || !event.shiftKey) {
          return;
        }
        openPickerAt(event);
      };
      document.addEventListener("click", onShiftClick, true);

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
      // An engine picked while a thread is open: the thread's hello already
      // told the channel which pipeline to run, so the switch waits for
      // thread-close.
      let pendingEngine: number | undefined;
      const recomputeEffective = (): IntentPipelineConfig =>
        effectiveConfig(viteOption, { ...loadIntentOverrides(), ...sessionOverrides });
      const stripState = (note?: string): ConfigStripState => ({
        config,
        ...(pendingEngine !== undefined
          ? { pendingEngine: TRANSCRIPTION_ENGINES[pendingEngine]?.label }
          : {}),
        sessionDirty: Object.keys(sessionOverrides).length > 0,
        saved: Object.keys(loadIntentOverrides()).length > 0,
        ...(note !== undefined ? { note } : {}),
      });
      const applyEngine = (index: number): void => {
        const engine = TRANSCRIPTION_ENGINES[index];
        if (engine === undefined) {
          return;
        }
        sessionOverrides = { ...sessionOverrides, ...engine.overrides };
        pendingEngine = undefined;
        applyEffective(recomputeEffective());
        strip.render(stripState());
        ctx.setStatus(
          `transcriber → ${engine.label} (${engine.shape}) — this session only (K, then S to save)`,
        );
      };
      // L cycles the linter: off → openai → gemini → off. Orthogonal to the
      // tier; a mid-thread change applies like any session override — the
      // NEXT thread's hello carries it (this thread's session is already up).
      const cycleLinter = (): void => {
        const order = ["off", "openai", "gemini"] as const;
        const current = config.linter ?? "off";
        const next = order[(order.indexOf(current) + 1) % order.length];
        sessionOverrides = { ...sessionOverrides, linter: next };
        applyEffective(recomputeEffective());
        strip.render(stripState());
        ctx.setStatus(
          next === "off"
            ? "linter off — this session only (K, then S to save)"
            : `linter → ${next} — lints each pause on the next turn (session only)`,
        );
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
          case "config-linter":
            cycleLinter();
            break;
          case "config-engine":
            if (engine.threadOpen) {
              pendingEngine = command.index;
              ctx.setStatus(
                `transcriber → ${TRANSCRIPTION_ENGINES[command.index]?.label} — applies when this thread closes`,
              );
            } else {
              applyEngine(command.index);
            }
            // Picking an engine IS the strip's terminal act — auto-dismiss
            // (the status line above carries the confirmation).
            strip.hide();
            renderHud();
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
            pendingEngine = undefined;
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
          case "tweak-toggle":
            // Tweak mode (§B.5): hand the pointer and keyboard back to the app
            // mid-turn, then resume composing the SAME turn. The thread and
            // its socket stay open, and selection stays live — the
            // onSelectionChange subscription above gates on threadOpen, never
            // on mode, so a re-selection during tweak appends its
            // app-selection event to the open turn. The reconciler surfaces
            // release the rest from the mode itself: ink-routing drops the
            // pointer (tweaking isn't composing-shaped), the cursor surface
            // clears the crosshair (no cursor in tweaking's table row), and
            // the veil guard cancels a mid-hold shot.
            engine.setMode(engine.mode === "tweak" ? "ink" : "tweak");
            if (engine.mode === "tweak") {
              ctx.setStatus("tweak — the page has the keyboard; T or Esc resumes the turn");
            }
            break;
          case "vscode-toggle":
            // VS Code jump mode: a tweak-shaped handover whose one claimed
            // gesture is the double-click — it opens the jump picker (the
            // capture-phase listener above; chains from ./vscode.ts).
            // Pointer and keys otherwise belong to the page, exactly like
            // tweak.
            engine.setMode(engine.mode === "vscode" ? "ink" : "vscode");
            if (engine.mode === "vscode") {
              ctx.setStatus(
                "vscode — double-click an element to pick a jump target; J or Esc resumes",
              );
            }
            break;
          case "jump-move":
            picker.move(command.delta);
            break;
          case "jump-close":
            picker.hide();
            break;
          case "help-toggle":
            // H — the universal help convention: the keymap table lives in
            // the widget panel (the pill's ? is the mouse path to the same).
            if (ctx.panelOpen()) {
              ctx.closePanel();
            } else {
              ctx.openPanel();
            }
            break;
          case "jump-commit": {
            // Enter commits the picker's selection; a digit commits that
            // numbered row directly. A digit past the list (or nothing
            // selectable) is a no-op — the picker already names the miss.
            const target =
              command.index !== undefined
                ? picker.targetAt(command.index)
                : picker.selectedTarget();
            if (target?.url === undefined) {
              break;
            }
            picker.hide();
            ctx.setStatus(
              `vscode → ${target.kind === "cell" ? `cell ${target.label} @ ${target.loc ?? ""}` : (target.loc ?? "")}`,
            );
            // The jump blurs this window when the editor takes focus; the
            // blur handler steps out of vscode mode (blurExits in the mode
            // table), so returning to the tab resumes composing.
            navigate(target.url);
            break;
          }
          case "video-toggle":
            // Screen share feeds the LINTER: the live model is what watches
            // the sampled frames. With the linter off (and no legacy realtime
            // submode), name the fix and do nothing else.
            if ((config.linter ?? "off") === "off" && config.submode !== "realtime") {
              ctx.setStatus("video needs the linter — K, then L");
              break;
            }
            void capture.toggleVideoShare();
            break;
          case "send":
            engine.send();
            ink.clear();
            break;
          case "step-out":
            // The ink-mode guard matters for tweak: stepping out of tweak
            // lands back in ink/composing with nothing to clear — the
            // excursion drew no ink, and the turn's strokes must survive it.
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
        () => picker.open,
        dispatch,
      );

      // ── advanced config panel (gear → raw JSON over the full effective config) ─
      // Apply mutates the live config in place: dynamic reads (mock cadence, ink
      // fade, talk mode, transcriber/corrector) pick it up, engine.settings is
      // synced (autoEndSec), the
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
          () => picker.open,
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
          pendingEngine = undefined;
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
        // any engine waiting on thread-close) yields to it, like a panel Apply.
        sessionOverrides = {};
        pendingEngine = undefined;
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
      // reader can mirror it (read-only). Deduped — only a real change is
      // worth a bus message.
      let lastPreview = "";
      const broadcastPreview = (): void => {
        if (!bus) {
          return;
        }
        // The mirror travels STRUCTURED (the defer-rendering rule applies to
        // mirrors too: intent crosses the bus as data; presentation is each
        // surface's own decision — the reader renders chips, not our prose).
        // Shots ride as their marker only (pixels stay in this tab);
        // selections — code and app — as locator + clipped excerpt (the full
        // text already rides the stream as its event). `text` remains the
        // legacy flat rendering so older views keep working.
        const composed = engine.threadOpen ? composeIntent(currentThreadEvents()).items : [];
        const items: PreviewItem[] = composed.map((i) =>
          i.kind === "shot"
            ? {
                kind: "shot",
                marker: i.marker ?? "shot",
                ...(i.viewport ? { viewport: true } : {}),
              }
            : i.kind === "code-selection"
              ? {
                  kind: "code-selection",
                  ...(i.sourceLoc !== undefined ? { sourceLoc: i.sourceLoc } : {}),
                  excerpt: codeExcerpt(i.text ?? ""),
                  ...(i.lines !== undefined ? { lines: i.lines } : {}),
                  ...(i.marker !== undefined ? { marker: i.marker } : {}),
                }
              : i.kind === "app-selection"
                ? {
                    kind: "app-selection",
                    ...(i.sourceLoc !== undefined ? { sourceLoc: i.sourceLoc } : {}),
                    excerpt: codeExcerpt(i.text ?? ""),
                    ...(i.marker !== undefined ? { marker: i.marker } : {}),
                  }
                : { kind: "text", text: i.text ?? "" },
        );
        const text = items
          .flatMap((i) =>
            i.kind === "text"
              ? [i.text]
              : i.kind === "code-selection"
                ? [`[code: ${i.sourceLoc ?? "selection"} “${i.excerpt}”]`]
                : i.kind === "app-selection"
                  ? [`[sel: “${i.excerpt}”]`]
                  : [],
          )
          .join(" ")
          .trim();
        const fingerprint = JSON.stringify(items);
        if (fingerprint === lastPreview) {
          return;
        }
        lastPreview = fingerprint;
        const snapshot: PreviewSnapshot = {
          text,
          items,
          threadOpen: engine.threadOpen,
          armed: engine.armed,
        };
        bus.set("preview", snapshot);
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
          // The engine can end a talk itself — send()/setArmed(false)/
          // stepOut() close the thread mid-hold and end only the LOG's talk;
          // the keymap's talk-end never fires. Release the shell's capture
          // FIRST: its synchronous part stops frame routing, so no PCM frame
          // chases the closing socket ("audio frame rejected: connection
          // closed" ×N) and the worklet doesn't stay hot after the turn.
          void talk.releaseCapture();
          if (event.reason === "send") {
            void wire.finalizeThread();
          } else {
            void wire.cancelThread();
          }
          // An engine picked mid-thread lands now — before any next thread
          // opens, so the next hello carries it.
          if (pendingEngine !== undefined) {
            applyEngine(pendingEngine);
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
          document.removeEventListener("dblclick", onDblClick, true);
          document.removeEventListener("click", onShiftClick, true);
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
  isPickerOpen: () => boolean,
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
        pickerOpen: isPickerOpen(),
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

// HMR guard: the mounted intent tool holds RUNNING closures from this module,
// and a hot swap would strand them on stale code while fresh modules load
// around them (the silent-stale-tab footgun: pushes flow, the view ignores
// them). Declining makes any edit here a full page reload — mount-once code
// has no meaningful hot path.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // decline() is a NO-OP in Vite 5+ — invalidate-on-accept is the working
    // way to say "this module has no hot path": the update re-propagates as
    // if unaccepted and lands as a full page reload.
    import.meta.hot?.invalidate();
  });
}
