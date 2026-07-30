/**
 * types.ts — the lanes' external contract: the thread-dial test seam
 * (OpenThread), the factory input (ChannelLanesConfig), and the returned
 * handle (ChannelLanes). Type-only module.
 */

import type { PcmSource, SpeechPlayer, Talk } from "@habemus-papadum/aiui-intent-runtime/talk";
import type { Wire } from "@habemus-papadum/aiui-intent-runtime/wire";
import type { Engine, IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import type { KeySource, OracleSession, OracleTransport } from "@habemus-papadum/aiui-oracle";
import type { Accessor } from "solid-js";
import type { CdpAlignment } from "../cdp-align";
import type { ClaimLaneOptions } from "../claims";
import type { IntentClient, IntentLanes } from "../client";
import type { LinterPulseView } from "../linter-pulse";
import type { PageToolsRegistry } from "../page-tools";
import type { Sink } from "../spec";
import type { IntentHost } from "../transport";
import type { TurnMirror } from "./mirror";
import type { OracleToolSource } from "./oracle";

/** The seam createWire dials threads through — injectable for tests. */
export type OpenThread = (options: {
  url: string;
  meta: Record<string, unknown>;
  onServerMessage: (msg: unknown) => void;
}) => Promise<unknown>;

/**
 * The shared-state context standing in for the factory closure: the capture
 * lanes and the verbs are built as `create*(ctx)` over this. `pencilTabs`
 * genuinely crosses the pump/verbs boundary (the pump adds, disarm's sweep
 * clears), so it rides here. `pageInteracted` deliberately does NOT — its
 * writer and readers both live inside capture-lanes.ts, so it stays a private
 * closure variable there.
 */
export interface LaneContext {
  host: IntentHost;
  config: ChannelLanesConfig;
  engine: Engine;
  wire: Wire;
  talk: Talk;
  speech: SpeechPlayer;
  status: (line: string) => void;
  toast: (msg: string) => void;
  pencilTabs: Set<number>;
  /**
   * The pause gate (owner, 2026-07-30) — crosses the verbs/capture boundary
   * like `pencilTabs`: verbs.setPaused writes `paused` and fires the hooks;
   * the capture wing installs them (the tab snapshot at pause, the
   * compare-and-emit at resume) and reads `paused` to suppress mid-pause
   * boundaries (navigation / tab-switch / a stray regionDrag).
   */
  pauseGate: { paused: boolean; onPause?: () => void; onResume?: () => void };
  /**
   * Where a contribution goes right now (O3d) — the machine's `sink`, read at
   * ACT time rather than passed in, because a shot's grab is async and the
   * sink could have moved while the pixels were being taken. Undefined until
   * `bind` supplies the client (nothing can contribute before then anyway).
   */
  sink?: () => Sink | undefined;
  /** The oracle session contributions fork to (O3d). */
  oracle: OracleSession;
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
  /**
   * Test seams for the ORACLE (O3a), the same shape as `openThread` and
   * `pcmSource` above: a fake transport lets a test drive a session's whole
   * lifecycle — including the endings nobody asks for (the vendor's ~60-minute
   * cap, a dropped data channel) — without a real WebRTC peer, and a fake key
   * source removes the mint from the picture. Absent in production: the panel
   * uses the WebRTC transport and the channel's mint.
   */
  oracleTransport?: OracleTransport;
  oracleKeySource?: KeySource;
  /** Test seam: the panel's page-tools registry (O3b). Absent = built over the
   * host's own page-event stream, which is what production does. */
  pageTools?: PageToolsRegistry;
  /** Console-channel status line (wire:/talk: narration). */
  onStatus?: (line: string) => void;
  /** The misuse/error channel (toasts in the page). */
  onToast?: (message: string) => void;
  /**
   * The CDP-alignment snapshot (src/cdp-align.ts), read at each thread-open
   * and sent as `meta.cdp` on the hello — the channel renders it into the
   * prompt prelude so the agent knows whether its DevTools MCP sees the same
   * browser the user does. Absent/undefined = nothing to declare.
   */
  cdpAlignment?: () => CdpAlignment | undefined;
}

export interface ChannelLanes {
  lanes: IntentLanes;
  /** Claim hooks for createIntentClient (the real video pump + ink fade). */
  claimOptions: ClaimLaneOptions;
  /**
   * The oracle session (O3a) — STABLE from construction, connected and closed
   * by its claim, so the mind strip and the ledger viewer can bind to it from
   * the first render. Its status is the session's own; whether the desire is
   * on is the mode engine's `oracle` region.
   */
  oracle: OracleSession;
  /**
   * The panel's own view of the driven page's tools (O3b) — what the oracle's
   * surface is projected from, and the handle a later slice (the panel bar's
   * tools, the trace's "what could it call") reads.
   */
  pageTools: PageToolsRegistry;
  /** Which app the oracle's tool surface came from (O3b/O3d) — reactive, and
   * shown in the panel because the last-app rule lets it be a tab the
   * developer is not looking at. */
  toolSource: Accessor<OracleToolSource | undefined>;
  /** The wire engine — the intent-event source (preview/trace read it). */
  engine: Engine;
  wire: Wire;
  talk: Talk;
  speech: SpeechPlayer;
  /** Where a lint is in its lifecycle (the sidecar's machine, mirrored) —
   * the tiny pulse dot beside the linter select reads this. */
  linterPulse: () => LinterPulseView;
  /**
   * CONVERSE (debug) turn control — the lint-now button beside the linter
   * select (capture-bus-and-consumers.md §6 Phase 1): ends the lint turn at
   * the button. Rides the mid-thread `control` rail — no open thread, no-op.
   * (The stop verb was removed client-side 2026-07-19 — voice barge-in
   * cancels an in-flight reply; the channel still honors `lint`/`stop` on
   * the rail.)
   */
  lintNow(): void;
  /**
   * Reactive event cursor: reading it inside the graph subscribes to every
   * engine event, so panes over `engine.events` re-render per event.
   */
  eventsRev: Accessor<number>;
  /** The current thread's events, reactively (empty when no thread ever). */
  threadEvents(): IntentEvent[];
  /**
   * Does the OPEN thread hold anything worth lowering — the same predicate
   * `sendTurn` uses to distinguish a real turn from an empty one. Read
   * imperatively by the UI's abandon-confirm gate (a live snapshot, not a
   * reactive subscription), so a turn-cap tap only prompts when something
   * would actually be lost.
   */
  turnHasContent(): boolean;
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
