/**
 * lanes.ts — the REAL lanes: the shared intent pipeline (Engine +
 * composeIntent), the wire (createWire/openIntentThread), the talk shell
 * (createTalk), the speech player, and the video frame pump — bound as
 * `IntentLanes` + claim hooks over the host seam. Every module here is an
 * unchanged import from the overlay's shared shell (the salvage list);
 * what's new is only the binding.
 *
 * Division of truth (parity ledger "engine dual-truth: designed out"): the
 * MODE engine owns armed/turn as the single machine; the WIRE engine is
 * DRIVEN — `openTurn`/`send`/`stepOut` are called from the verbs, and its
 * own events flow BACK as `client.emit("turnClosed")` when the thread dies
 * under us (idle timeout, server close). Nothing dual-writes.
 *
 * Config consumers (the "kept getting lost" list, now consuming):
 *  - stt / linter → the engine's IntentPipelineConfig, declared on every
 *    hello (panelIntentConfig, salvaged from the old panel's turn.ts);
 *  - videoPeriodSec → the sampler's constant-mode cadence, read per tick;
 *  - inkFade/inkVanish → the ink claim's fadeSec + a live re-relay effect;
 *  - shotFlash → the manual-shot flash gate (sampled frames never flash).
 */

import {
  composeIntent,
  DEFAULT_INTENT_CONFIG,
  Engine,
  expandTier,
  type IntentEvent,
  type IntentPipelineConfig,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { openIntentThread } from "@habemus-papadum/aiui-dev-overlay/intent-thread";
import {
  createTalk,
  type PcmSource,
  SpeechPlayer,
  type Talk,
  WorkletPcmSource,
} from "@habemus-papadum/aiui-dev-overlay/multimodal-talk";
import { VideoSampler } from "@habemus-papadum/aiui-dev-overlay/multimodal-video";
import { createWire, type Wire } from "@habemus-papadum/aiui-dev-overlay/wire";
import { type Accessor, createEffect, createRoot, createSignal } from "solid-js";
import type { ClaimLaneOptions } from "./claims";
import type { IntentClient, IntentLanes } from "./client";
import { inkFade, inkVanish, linter, shotFlash, stt, videoPeriodSec } from "./config";
import type { IntentHost } from "./transport";

/**
 * The effective intent config, declared on every hello (salvaged verbatim
 * from the old panel's turn.ts — model names on the surface, shared tiers
 * underneath).
 */
export function panelIntentConfig(sttName: string, linterName?: string): IntentPipelineConfig {
  const base =
    sttName === "scribe-v2"
      ? { ...expandTier("premium"), transcriber: "elevenlabs" as const }
      : sttName === "gpt-4o-transcribe"
        ? { ...expandTier("premium"), model: "gpt-4o-transcribe" }
        : sttName === "gpt-4o-mini-transcribe"
          ? expandTier("premium")
          : expandTier("rapid");
  return {
    ...DEFAULT_INTENT_CONFIG,
    ...base,
    ...(linterName !== undefined && linterName !== "off" ? { linter: linterName as never } : {}),
  };
}

/** The events since the last thread-open — the compose/replay unit. */
export function currentThreadEvents(events: readonly IntentEvent[]): IntentEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      return events.slice(i);
    }
  }
  return [];
}

/** The seam createWire dials threads through — injectable for tests. */
export type OpenThread = (options: {
  url: string;
  meta: Record<string, unknown>;
  onServerMessage: (msg: unknown) => void;
}) => Promise<unknown>;

/** Turn persistence across page reloads (the old panel's storage.session
 * mirror, plain-page grade). Default: sessionStorage under `aiui2.turn`. */
export interface TurnMirror {
  persist(events: IntentEvent[], threadOpen: boolean): void;
  recover(): { events: IntentEvent[]; threadOpen: boolean } | undefined;
}

const MIRROR_KEY = "aiui2.turn";

export function sessionStorageMirror(storage: Storage = sessionStorage): TurnMirror {
  return {
    persist(events, threadOpen) {
      if (threadOpen && events.length > 0) {
        storage.setItem(MIRROR_KEY, JSON.stringify({ events, threadOpen, savedAt: Date.now() }));
      } else {
        storage.removeItem(MIRROR_KEY);
      }
    },
    recover() {
      try {
        const raw = storage.getItem(MIRROR_KEY);
        if (raw === null) {
          return undefined;
        }
        const got = JSON.parse(raw) as { events?: IntentEvent[]; threadOpen?: boolean };
        return Array.isArray(got.events) && got.events.length > 0
          ? { events: got.events, threadOpen: got.threadOpen === true }
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export interface ChannelLanesConfig {
  host: IntentHost;
  /** The bound channel port (undefined = degraded; sends will say so). */
  port: () => number | undefined;
  /** Turn persistence; defaults to sessionStorage. Pass null to disable. */
  mirror?: TurnMirror | null;
  /** Identity of the driven surface for the hello's context block. */
  tabMeta?: () => Promise<Record<string, unknown> | undefined>;
  /** PCM capture factory; defaults to the blob-URL AudioWorklet source
   * (fine on a plain page — the MV3 CSP that forced a shipped file is an
   * extension-host concern). */
  pcmSource?: () => PcmSource;
  /** Test seam: replace the real WebSocket thread dialer. */
  openThread?: OpenThread;
  /** Console-channel status line (wire:/talk: narration). */
  onStatus?: (line: string) => void;
  /** The misuse/error channel (toasts in the page). */
  onToast?: (message: string) => void;
  /** The channel echoed the lowered prompt for the sent turn. */
  onLoweredPrompt?: (prompt: string) => void;
}

export interface ChannelLanes {
  lanes: IntentLanes;
  /** Claim hooks for createIntentClient (the real video pump + ink fade). */
  claimOptions: ClaimLaneOptions;
  /** The wire engine — the intent-event source (preview/trace read it). */
  engine: Engine;
  wire: Wire;
  talk: Talk;
  speech: SpeechPlayer;
  /**
   * Reactive event cursor: reading it inside the graph subscribes to every
   * engine event, so panes over `engine.events` re-render per event.
   */
  eventsRev: Accessor<number>;
  /** The current thread's events, reactively (empty when no thread ever). */
  threadEvents(): IntentEvent[];
  /**
   * Bind the wire-engine's world back into the mode engine and start the
   * outbound config effects. Call once, right after createIntentClient.
   * Returns the unbind.
   */
  bind(client: IntentClient): () => void;
  /**
   * Recover a mirrored turn after a page reload: replays the events into
   * the wire engine (the wire re-dials on the replayed thread-open) and
   * re-opens the machine to armed+turn. The capture GRANT does not survive
   * a reload — the user re-grants with the activation gesture (idempotent).
   * Returns whether a turn was recovered. Call after bind().
   */
  recover(client: IntentClient): boolean;
}

export function createChannelLanes(config: ChannelLanesConfig): ChannelLanes {
  const { host } = config;
  const status = config.onStatus ?? (() => {});
  const toast = config.onToast ?? ((m: string) => console.warn("[intent-client]", m));

  // ── the shared intent pipeline: one engine per page ────────────────────────
  const engine = new Engine(panelIntentConfig(stt.get() as string, linter.get() as string));

  // ── speech playback (server-pushed clips; talking barges in) ───────────────
  const speech = new SpeechPlayer();

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
    uploadAttachment: (id, mime, bytes) => wire.uploadAttachment(id, mime, bytes),
    uploadAudio: (segment, seq, bytes) => wire.uploadAudio(segment, seq, bytes),
  });

  // ── the video frame pump (the real videoSample applier) ───────────────────
  // Smart mode's gate: page interaction pings arm one frame (read-and-clear).
  let pageInteracted = false;
  host.transport.onPageEvent((event) => {
    if (event.kind === "interaction") {
      pageInteracted = true;
    } else if (event.kind === "navigation") {
      // Same-tab navigation: context riding the turn (the engine no-ops
      // without an open thread), rendered into the prompt by composeIntent.
      engine.navigation(event.from, event.to, event.navKind);
    }
  });

  // ── tab boundaries: a switch mid-turn is a navigation event too — the
  // prompt should name where the user LEFT and where they went (the old
  // panel's exact semantics, minus chrome.tabs: identity via tabInfo).
  let lastActiveTab: { id: number; url?: string } | undefined;
  const seedTab = host.targeting.activeTab();
  if (seedTab !== undefined) {
    void host.targeting.tabInfo?.(seedTab).then((info) => {
      lastActiveTab ??= { id: seedTab, url: info?.url };
    });
  }
  host.targeting.onActiveTabChange((tab) => {
    void (async () => {
      const prev = lastActiveTab;
      if (tab === undefined) {
        return;
      }
      const to = await host.targeting.tabInfo?.(tab);
      lastActiveTab = { id: tab, url: to?.url };
      if (prev === undefined || prev.id === tab) {
        return;
      }
      // `from` re-read at boundary time: the tab may have navigated since it
      // was last active; the boundary names where the user actually left.
      const from = (await host.targeting.tabInfo?.(prev.id))?.url ?? prev.url;
      engine.navigation(from ?? "", to?.url ?? "");
    })();
  });

  const claimOptions: ClaimLaneOptions = {
    inkFadeSec: () => (inkVanish.get() === true ? (inkFade.get() as number) : 0),
    videoSampler: {
      start: async (desire) => {
        const sampler = new VideoSampler({
          captureFrame: async () => {
            try {
              return await host.capture.grabShot(desire.tab);
            } catch {
              return undefined; // no warm stream right now — the tick owes nothing
            }
          },
          sendFrame: (_frame, shot) => {
            const marker = engine.shotDone(
              { x: 0, y: 0, w: shot.width, h: shot.height },
              [],
              shot.thumb ?? "",
              undefined,
              false, // sampled, not manual — no flash, quieter preview
              Date.now(),
            );
            void wire.uploadAttachment(marker, shot.mime, shot.bytes);
          },
          intervalMs: () =>
            desire.mode === "smart" ? 1000 : (videoPeriodSec.get() as number) * 1000,
          shouldCapture: () => {
            if (desire.mode !== "smart") {
              return true;
            }
            const had = pageInteracted;
            pageInteracted = false;
            return had;
          },
          rearm: () => {
            pageInteracted = true; // the tick consumed the gate, delivered nothing
          },
        });
        sampler.start();
        return () => sampler.stop();
      },
    },
  };

  // ── the verbs ──────────────────────────────────────────────────────────────
  /** The open turn holds something worth lowering (explicit turns can be empty). */
  const turnHasContent = (): boolean =>
    composeIntent(currentThreadEvents(engine.events), "replace", { streaming: true }).items.length >
    0;

  const lanes: IntentLanes = {
    setArmed: (on) => {
      // Driving, not dual truth: the mode engine is the machine; the wire
      // engine is told. Its setArmed(false) is its own abandon (ends talk,
      // cancels an open thread) — exactly the disarm semantics.
      engine.setArmed(on);
    },
    openTurn: () => {
      engine.setArmed(true); // idempotent belt for same-dispatch arm+open
      engine.openTurn();
    },
    sendTurn: () => {
      if (!engine.threadOpen) {
        return;
      }
      if (turnHasContent()) {
        engine.send({ keepArmed: true }); // §13.6: the seat stays armed
      } else {
        engine.stepOut(); // an empty explicit turn: nothing to lower — cancel
        status("nothing in the turn — cancelled");
      }
    },
    cancelTurn: () => {
      if (engine.threadOpen) {
        engine.stepOut(); // closes with reason "cancel", stays armed
      }
    },
    takeShot: (tab) => {
      void (async () => {
        const takenAt = Date.now();
        try {
          const shot = await host.capture.grabShot(tab);
          // Camera-style confirmation, strictly AFTER the grab so the wash is
          // never in the frame it confirms. Manual shots flash; sampled never.
          if (shotFlash.get() === true) {
            void host.transport.requestPage(tab, "flash", { kind: "shot" }).catch(() => {});
          }
          const marker = engine.shotDone(
            { x: 0, y: 0, w: shot.width, h: shot.height },
            [],
            shot.thumb ?? "",
            undefined,
            true,
            takenAt,
          );
          await wire.uploadAttachment(marker, shot.mime, shot.bytes);
          status(`${marker} captured (${shot.width}×${shot.height})`);
        } catch (err) {
          toast(`shot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    addSelection: (tab) => {
      void (async () => {
        try {
          const selection = await host.transport.requestPage(tab, "selection");
          if (selection === null || selection === undefined) {
            status("no selection on the page");
            return;
          }
          engine.appSelection(selection as never);
        } catch (err) {
          toast(`selection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    clearInk: (tab) => {
      void host.transport.requestPage(tab, "ink", { clear: true }).catch(() => {});
      if (engine.threadOpen) {
        engine.inkCleared(false);
      }
    },
    startTalk: () => {
      talk.startMainListening();
    },
    stopTalk: () => {
      talk.stopMainListening();
    },
    setMicMuted: (muted) => {
      talk.setMicMuted(muted);
    },
  };

  // ── the engine → wire feed: every event, then the close verbs (the
  // overlay modality's exact composition; the wire does not self-subscribe).
  // Plus: the reactive event cursor for panes, and the turn mirror.
  const [eventsRev, setEventsRev] = createSignal(0);
  const mirror = config.mirror === null ? undefined : (config.mirror ?? sessionStorageMirror());
  engine.onEvent((event) => {
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

    // Live fade: the inkFade/inkVanish controls moving while ink is claimed
    // re-relay the new lifetime (idempotent re-assert; no release/acquire
    // flicker). The graph pushes — nothing hand-called. Owned by a root so
    // unbind disposes it (bind is called from plain page bootstrap code).
    const disposeFade = createRoot((dispose) => {
      createEffect(
        // EVERYTHING the handler needs is computed HERE — a read inside the
        // handler is untracked and warns STRICT_READ_UNTRACKED (the ledger's
        // "consume the value the source computed" rule; found live on this
        // very effect when grantedTab was read in the handler).
        () => ({
          fade: inkVanish.get() === true ? (inkFade.get() as number) : 0,
          // re-run when the claim lands too, not just when the controls move
          inkActive: client.claimStatuses().inkPointer?.phase === "active",
          tab: client.context().grantedTab,
        }),
        ({ fade, inkActive, tab }) => {
          if (inkActive && tab !== undefined) {
            void host.transport
              .requestPage(tab, "ink", { on: true, fadeSec: fade })
              .catch(() => {});
          }
        },
      );
      return dispose;
    });

    return () => {
      offEngine();
      disposeFade();
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
    // The machine follows the recovered wire truth (arm gate deliberately
    // bypassed: a recovered turn outranks a not-yet-connected bus — outages
    // never abandon turns).
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
    eventsRev,
    threadEvents: () => {
      void eventsRev(); // subscribe (in-graph readers re-run per event)
      return currentThreadEvents(engine.events);
    },
    bind,
    recover,
  };
}
