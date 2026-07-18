/**
 * lanes.ts — the REAL lanes: the shared intent pipeline (Engine +
 * composeIntent), the wire (createWire/openIntentThread), the talk shell
 * (createTalk), the speech player, and the video frame pump — bound as
 * `IntentLanes` + claim hooks over the host seam. Every module here is an
 * import from aiui-intent-runtime / aiui-lowering-pipeline (the retired
 * overlay's shared shell, extracted); what's new is only the binding.
 *
 * Division of truth (parity ledger "engine dual-truth: designed out"): the
 * MODE engine owns armed/turn as the single machine; the WIRE engine is
 * DRIVEN — `openTurn`/`send`/`stepOut` are called from the verbs, and its
 * own events flow BACK as `client.emit("turnClosed")` when the thread dies
 * under us (idle timeout, server close). Nothing dual-writes.
 *
 * Config consumers (the "kept getting lost" list, now consuming):
 *  - stt / linter → the engine's IntentPipelineConfig, declared on every
 *    hello (panelIntentConfig, salvaged from the retired panel's turn.ts);
 *  - videoPeriodSec → the sampler's constant-mode cadence, read per tick;
 *  - pencilFade/pencilVanish → the pencilSurface claim's fadeSec + a live
 *    re-relay effect;
 *  - shotFlash → the manual-shot flash gate (sampled frames never flash).
 */

import {
  createTalk,
  SpeechPlayer,
  WorkletPcmSource,
} from "@habemus-papadum/aiui-intent-runtime/talk";
import { openIntentThread } from "@habemus-papadum/aiui-intent-runtime/thread";
import { createWire } from "@habemus-papadum/aiui-intent-runtime/wire";
import { Engine } from "@habemus-papadum/aiui-lowering-pipeline";
import { createSignal } from "solid-js";
import type { IntentClient } from "../client";
import { linter, stt } from "../config";
import { createLinterPulse } from "../linter-pulse";
import { createCaptureLanes } from "./capture-lanes";
import { createConfigEffects } from "./config-effects";
import { sessionStorageMirror } from "./mirror";
import { currentThreadEvents, panelIntentConfig } from "./turn-config";
import type { ChannelLanes, ChannelLanesConfig, LaneContext, OpenThread } from "./types";
import { createVerbs } from "./verbs";

export { sessionStorageMirror, type TurnMirror } from "./mirror";
// The pipeline primitives, the mirror, and the lane contract now live in
// sibling modules; re-export them so `./lanes` keeps its historical surface
// (src/index.ts never exported these — the importers are ui/ext/tests).
export { currentThreadEvents, panelIntentConfig } from "./turn-config";
export type { ChannelLanes, ChannelLanesConfig, OpenThread } from "./types";

export function createChannelLanes(config: ChannelLanesConfig): ChannelLanes {
  const { host } = config;
  const status = config.onStatus ?? (() => {});
  const toast = config.onToast ?? ((m: string) => console.warn("[intent-client]", m));

  // ── the shared intent pipeline: one engine per page ────────────────────────
  const engine = new Engine(panelIntentConfig(stt.get() as string, linter.get() as string));

  // ── speech playback (server-pushed clips; talking barges in) ───────────────
  // The retired overlay's composition, adapted to the panel: the speaker line
  // rides the status line (🔊 — the overlay rendered a dedicated label), and
  // BLOCKED playback gets a visible remedy. The panels need that where the
  // overlay never did: with keys forwarded from the target tab, this document may hold
  // no user gesture when the first linter clip arrives — the player parks the
  // clip and resumes on the first click/keypress HERE (speech.ts).
  //
  // Which host can actually be blocked (measured, CfT 150, 2026-07-15 — an
  // AudioContext with zero user activation): a chrome-extension:// document is
  // EXEMPT from the autoplay gate (state "running"; the MV3 side panel plays
  // unconditionally — extension documents are, e.g. why MV2 background pages
  // could ding), while a plain web document is gated ("suspended"). So the
  // block is reachable only on the STANDALONE page — and the session browser
  // launches with autoplay pre-allowed, leaving exactly one blockable case: a
  // detached page opened in a regular, non-session browser.
  const speech = new SpeechPlayer({
    onSpeak: (label) => status(label === undefined ? "🔊 speaking…" : `🔊 ${label}`),
    onBlocked: () =>
      toast("audio is blocked until you click or press a key in this panel (browser policy)"),
  });

  // ── the wire: batching, attachment discipline, finalize/cancel ────────────
  const dialThread: OpenThread =
    config.openThread ??
    (async (options) =>
      openIntentThread({
        url: options.url,
        format: "intent-v1",
        meta: options.meta as never,
        onSocket: (socket) => {
          socket.onServerMessage((msg) => options.onServerMessage(msg));
        },
      }));

  const wire = createWire({
    engine,
    config: () => engine.settings,
    openThread: async (options) => {
      const port = config.port();
      if (port === undefined) {
        // No toast here: the wire surfaces send-time failures itself.
        throw new Error("no channel bound");
      }
      const tab = await config.tabMeta?.();
      return (await dialThread({
        url: `ws://127.0.0.1:${port}/ws`,
        meta: {
          ...(tab !== undefined ? { tab } : {}),
          actor: "human",
          ...(options.intent !== undefined ? { intent: options.intent } : {}),
        },
        onServerMessage: (msg) => {
          const m = msg as { kind?: string; message?: string; source?: string; prompt?: unknown };
          if (m.kind === "error" && typeof m.message === "string") {
            toast(`${m.source ?? "channel"}: ${m.message}`);
          } else if (m.kind === "lowered-prompt" && typeof m.prompt === "string") {
            config.onLoweredPrompt?.(m.prompt);
            status("turn sent — lowered prompt received");
          }
        },
      })) as never;
    },
    setStatus: (text) => status(`wire: ${text}`),
    reportError: (error) => toast(`${error.source ?? "channel"}: ${error.message}`),
    clearSelection: () => {}, // pull model: selections are engine events
    enqueueSpeech: (clip) => speech.enqueue(clip),
  });

  // ── talk: the shell lanes, panel-document mic (M9) ─────────────────────────
  const talk = createTalk({
    engine,
    config: () => engine.settings,
    pcmSource: config.pcmSource ?? (() => new WorkletPcmSource()),
    setStatus: (text) => status(`talk: ${text}`),
    reportError: (error) => toast(`${error.source ?? "talk"}: ${error.message}`),
    bargeIn: () => speech.bargeIn(),
    getThread: () => wire.getThread(),
    flushOutbox: (known) => wire.flushOutbox(known as never),
    uploadAudio: (segment, seq, bytes) => wire.uploadAudio(segment, seq, bytes),
  });

  // ── the shared-state context: the capture lanes and the verbs are built
  // over it. `pencilTabs` rides here because it crosses that boundary — every
  // pencil engage lands here (the pencilSurface claim's release only
  // disengages, so a mid-turn tab switch leaves markup on more than one tab),
  // and disarm's sweep (clearAllPencils) clears it. Everything else on the
  // context is a stable reference to the pipeline built above.
  const pencilTabs = new Set<number>();
  const ctx: LaneContext = {
    host,
    config,
    engine,
    wire,
    talk,
    speech,
    status,
    toast,
    pencilTabs,
  };

  // ── the capture wing: the page-event pump (region-drag crop, smart-mode
  // interaction gate, same-tab navigation), the tab-switch boundary tracker,
  // and the claim hooks (ink fade + the video frame pump). ───────────────────
  const claimOptions = createCaptureLanes(ctx);

  // ── the verbs: the IntentLanes the mode engine drives, over the context ────
  const lanes = createVerbs(ctx);

  // ── the linter pulse: the sidecar's state machine, mirrored for the dot ────
  const pulse = createLinterPulse({
    enabled: () => linter.get() !== "off",
    onStale: () => toast("linter: no note within 4s — check the channel log"),
  });

  // ── the engine → wire feed: every event, then the close verbs (the
  // retired overlay's exact composition; the wire does not self-subscribe).
  // Plus: the reactive event cursor for panes, and the turn mirror.
  const [eventsRev, setEventsRev] = createSignal(0);
  const mirror = config.mirror === null ? undefined : (config.mirror ?? sessionStorageMirror());
  engine.onEvent((event) => {
    pulse.feed(event);
    wire.onEngineEvent(event);
    if (event.type === "thread-close") {
      if ((event as { reason?: string }).reason === "send") {
        void wire.finalizeThread();
      } else {
        void wire.cancelThread();
      }
    }
    setEventsRev((n) => n + 1);
    mirror?.persist(currentThreadEvents(engine.events), engine.threadOpen);
  });

  // ── the world flows back: wire-engine events → mode-engine bindings ───────
  const bind = (client: IntentClient): (() => void) => {
    const offEngine = engine.onEvent((event) => {
      if (event.type === "thread-close") {
        // send/cancel already moved the phase (their dispatches); a timeout
        // or server-side close arrives ONLY here — emit is idempotent.
        client.emit("turnClosed");
        void talk.releaseCapture(); // nothing outlives the thread
      }
    });

    // The three outbound live-config roots (pencil fade re-relay, in-place
    // stt/linter re-apply, mid-thread linter control chunk). Composite dispose.
    const disposeEffects = createConfigEffects(ctx, client);

    return () => {
      offEngine();
      disposeEffects();
    };
  };

  const recover = (client: IntentClient): boolean => {
    const got = mirror?.recover();
    if (got === undefined || !got.threadOpen) {
      return false;
    }
    // Replay re-feeds every listener: the wire re-dials on the replayed
    // thread-open, the panes see the events, the mirror re-persists.
    engine.replay(got.events, { threadOpen: true });
    // The machine follows the recovered wire truth — through the ordinary
    // commands, and therefore through the ordinary GATES. Arming requires a
    // channel, so this must be called once the bus is CONNECTED (the entries
    // do it on first connect). That is not a concession to the gate: a turn you
    // cannot send is not a turn you have recovered.
    //
    // (An earlier version leaned on the gate being advisory and armed anyway.
    // It worked only because `dispatch` did not enforce `available` — which is
    // exactly the loophole that let a key or an agent arm past any gate at all.)
    if (client.state().phase === "disarmed") {
      client.dispatch("arm");
    }
    if (client.state().phase === "armed") {
      client.dispatch("turn");
    }
    return client.state().phase === "turn";
  };

  return {
    lanes,
    claimOptions,
    engine,
    wire,
    talk,
    speech,
    linterPulse: pulse.view,
    eventsRev,
    threadEvents: () => {
      void eventsRev(); // subscribe (in-graph readers re-run per event)
      return currentThreadEvents(engine.events);
    },
    bind,
    recover,
  };
}
