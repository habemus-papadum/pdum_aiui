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
 *  - inkFade/inkVanish (and pencilFade/pencilVanish, ink's twin) → the ink /
 *    pencilSurface claims' fadeSec + a live re-relay effect each;
 *  - shotFlash → the manual-shot flash gate (sampled frames never flash).
 */

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
import {
  composeIntent,
  DEFAULT_INTENT_CONFIG,
  Engine,
  expandTier,
  type IntentEvent,
  type IntentPipelineConfig,
} from "@habemus-papadum/aiui-lowering-pipeline";
import { type Accessor, createEffect, createRoot, createSignal } from "solid-js";
import type { ClaimLaneOptions } from "./claims";
import type { IntentClient, IntentLanes } from "./client";
import {
  inkFade,
  inkVanish,
  linter,
  pencilFade,
  pencilVanish,
  shotFlash,
  stt,
  videoPeriodSec,
} from "./config";
import { createLinterPulse, type LinterPulseView } from "./linter-pulse";
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
    // No spoken "sent" ack, whatever the tier (owner, 2026-07-16): the premium
    // preset bundles audioBack:"acks" with its STT, but the panel confirms a
    // send VISUALLY (status line + preview) — a voice saying "sent" is noise.
    // Server-side this also skips the TTS seam entirely. The LINTER's spoken
    // notes are unaffected: their clips gate on `linter`, never `audioBack`
    // (the silent-linter rule, shell/wire.ts).
    audioBack: "off" as const,
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
  /** Where a lint is in its lifecycle (the sidecar's machine, mirrored) —
   * the tiny pulse dot beside the linter select reads this. */
  linterPulse: () => LinterPulseView;
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
   * Returns whether a turn was recovered.
   *
   * Call after bind(), and once the channel is CONNECTED: re-arming goes
   * through the ordinary `arm` command, which the machine gates on having a
   * channel. A turn you cannot send is not a turn you have recovered.
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
  // The overlay's composition, adapted to the panel: the speaker line rides the
  // status line (🔊 — the overlay renders a dedicated label), and BLOCKED
  // playback gets a visible remedy. The panels need that where the overlay
  // never did: with keys forwarded from the target tab, this document may hold
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
    uploadAttachment: (id, mime, bytes) => wire.uploadAttachment(id, mime, bytes),
    uploadAudio: (segment, seq, bytes) => wire.uploadAudio(segment, seq, bytes),
  });

  // ── the video frame pump (the real videoSample applier) ───────────────────
  // Smart mode's gate: page interaction pings arm one frame (read-and-clear).
  let pageInteracted = false;
  host.transport.onPageEvent((event) => {
    if (event.kind === "regionDrag") {
      // The armed `a` drag completed: crop the region (host-native — CDP clip
      // or the warm stream's canvas), then into the turn exactly like a shot.
      void (async () => {
        try {
          const shot =
            host.capture.grabRegion !== undefined
              ? await host.capture.grabRegion(event.tab, event.rect, event.viewport)
              : await host.capture.grabShot(event.tab); // degraded: full frame
          if (shotFlash.get() === true) {
            void host.transport.requestPage(event.tab, "flash", { kind: "shot" }).catch(() => {});
          }
          const marker = engine.shotDone(
            event.rect,
            (event.components ?? []) as never,
            shot.thumb ?? "",
            undefined,
            false,
            event.takenAt,
          );
          await wire.uploadAttachment(marker, shot.mime, shot.bytes);
          status(
            `${marker} captured (region ${Math.round(event.rect.w)}×${Math.round(event.rect.h)})`,
          );
        } catch (err) {
          toast(`region shot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }
    if (event.kind === "interaction") {
      pageInteracted = true;
    } else if (event.kind === "navigation") {
      // Same-tab navigation: context riding the turn (the engine no-ops
      // without an open thread), rendered into the prompt by composeIntent.
      engine.navigation(event.from, event.to, event.navKind);
    }
  });

  // ── tab boundaries: switching WHICH tab you look at mid-turn is its own
  // boundary — a `tab-switch` event, distinct from a same-tab navigation, so
  // the prompt says "you switched tabs" and carries both tab identities (the
  // old panel conflated the two into one navigation; the split is owner,
  // 2026-07-16). Identity via tabInfo, not chrome.tabs.
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
      // was last active; the boundary names where the user actually left, and
      // the two tab handles ride along.
      const from = (await host.targeting.tabInfo?.(prev.id))?.url ?? prev.url;
      engine.tabSwitch(from ?? "", to?.url ?? "", prev.id, tab);
    })();
  });

  const claimOptions: ClaimLaneOptions = {
    inkFadeSec: () => (inkVanish.get() === true ? (inkFade.get() as number) : 0),
    pencilFadeSec: () => (pencilVanish.get() === true ? (pencilFade.get() as number) : 0),
    videoSampler: {
      start: async (desire) => {
        const sampler = new VideoSampler({
          captureFrame: async () => {
            try {
              // Sampled frames keep a CAPPED thumb (owner, 2026-07-16): a full-res
              // thumb rides every frame, so it would bloat the events + the trace.
              // Manual/area shots (infrequent) leave it full-res for a crisp peek.
              // 1024 matches the dev-overlay's sampled-frame cap.
              return await host.capture.grabShot(desire.tab, { thumbMaxPx: 1024 });
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
    // NOTE: armRegion/armJump are gone (owner, 2026-07-16). Area and jump are
    // TOGGLE modes now; the regionSurface/jumpSurface claims (claims.ts) arm and
    // lower the page overlays as the mode flips — no imperative lane call. The
    // `regionDrag` page event below still crops + uploads the completed drag.
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
    clearPencil: (tab) => {
      void host.transport.requestPage(tab, "pencil", { op: "clear" }).catch(() => {});
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

  // ── the linter pulse: the sidecar's state machine, mirrored for the dot ────
  const pulse = createLinterPulse({
    enabled: () => linter.get() !== "off",
    onStale: () => toast("linter: no note within 4s — check the channel log"),
  });

  // ── the engine → wire feed: every event, then the close verbs (the
  // overlay modality's exact composition; the wire does not self-subscribe).
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

    // Pencil live fade — the EXACT twin of ink's disposeFade above (owner,
    // 2026-07-16). Engage / disengage / re-point across a tab switch are now the
    // `pencilSurface` CLAIM's job (claims.ts), so this effect only re-relays the
    // vanish lifetime while the claim is active — no hand-rolled lifecycle.
    const disposePencilFade = createRoot((dispose) => {
      createEffect(
        () => ({
          fade: pencilVanish.get() === true ? (pencilFade.get() as number) : 0,
          active: client.claimStatuses().pencilSurface?.phase === "active",
          tab: client.context().activeTab,
        }),
        ({ fade, active, tab }) => {
          if (active && tab !== undefined) {
            void host.transport
              .requestPage(tab, "pencil", { op: "fade", fadeSec: fade })
              .catch(() => {});
          }
        },
      );
      return dispose;
    });

    // Live config: the stt/linter selects moving mid-session re-apply the
    // engine's IntentPipelineConfig IN PLACE — the overlay's `applyEffective`,
    // distilled (modality.ts: delete-then-assign on the live object, which
    // every consumer reads through a thunk). Without this the selects were
    // boot-frozen: the next hello still declared the OLD linter, and the
    // wire's linter-clip gate (`config().linter !== "off"`, shell/wire.ts)
    // silently dropped the clips a mid-session switch-on should have played.
    const disposeConfig = createRoot((dispose) => {
      createEffect(
        () => panelIntentConfig(stt.get() as string, linter.get() as string),
        (effective) => {
          const live = engine.settings as unknown as Record<string, unknown>;
          for (const key of Object.keys(live)) {
            if (!(key in effective)) {
              delete live[key]; // e.g. ttsModel when stepping down from premium
            }
          }
          Object.assign(engine.settings, effective);
        },
      );
      return dispose;
    });

    // Mid-thread linter control: the linter select moving WHILE a turn is open
    // sends a `control` chunk so the sidecar starts/stops/swaps on the CURRENT
    // thread — not just the next hello (which disposeConfig above already
    // updated engine.settings for). No open thread → no-op (the hello carries
    // it). Seeded from the current value so the first real change is caught,
    // never the mount.
    const disposeLinterControl = createRoot((dispose) => {
      let last = linter.get() as string;
      createEffect(
        () => linter.get() as string,
        (value) => {
          if (value === last) {
            return;
          }
          last = value;
          if (engine.threadOpen) {
            void wire.sendControl("linter", value);
          }
        },
      );
      return dispose;
    });

    return () => {
      offEngine();
      disposeFade();
      disposePencilFade();
      disposeConfig();
      disposeLinterControl();
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
