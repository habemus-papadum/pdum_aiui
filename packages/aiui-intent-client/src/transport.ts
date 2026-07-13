/**
 * transport.ts — the page-transport seam (intent-client 02 §5 / 03 §4).
 *
 * Everything the client needs from "the pages it drives" fits behind three
 * small interfaces. The page-side contract is the one the old content script
 * already serves — `serveRelay("page", { selection, viewport, ink, keylayer,
 * flash })` — so the production `ExtensionBus` is today's relay verbatim;
 * the `CdpBus` delivers the same capabilities over Runtime.evaluate; and the
 * `FakeBus` (./fake-bus.ts) is what every harness test drives.
 *
 * The client core never imports chrome.*, CDP, or a DOM: it talks to these
 * types only. That is the whole point — the brain is host-agnostic and
 * headless-testable, and the host is a constructor argument.
 */

/** The page capabilities a transport must deliver (the relay's command set).
 * `locate` is the aiui-instrumented-page capability (screenshot rectangle →
 * components → source): declared now so the seam anticipates the overlay's
 * jump-to-VS-Code mode; only instrumented pages answer it. */
export type PageCapability = "ink" | "keylayer" | "flash" | "selection" | "viewport" | "locate";

/** The on-page indicator's asserted state (a claim's desire, as data). */
export interface RingState {
  on: boolean;
  /** The richer tone while a turn is open (turn/tweak). */
  turnTone: boolean;
}

/** Events pages push at the panel (the inbound half of the old relay). */
export type PageEvent =
  | { kind: "selectionPresent"; tab: number; present: boolean }
  | { kind: "interaction"; tab: number }
  | { kind: "keyForward"; tab: number; key: string; phase: "down" | "up"; repeat: boolean }
  /** A same-tab navigation (SPA route, reload, hash) — context riding the
   * turn, rendered into the prompt by the wire engine. */
  | {
      kind: "navigation";
      tab: number;
      from: string;
      to: string;
      navKind?: "push" | "replace" | "traverse" | "reload" | "hash";
    }
  /** The page announced whether it is aiui-INSTRUMENTED (window.__AIUI__):
   * instrumented pages answer `locate` and can host jump-to-editor. */
  | { kind: "aiuiSupport"; tab: number; supported: boolean };

/** Tab-scoped request/response + ring broadcast + page→panel events. */
export interface PageTransport {
  /** Invoke one page capability on one tab (the relayRequestTab shape). */
  requestPage(tab: number, capability: PageCapability, payload?: unknown): Promise<unknown>;
  /** Assert the indicator ring everywhere (fire-and-forget, idempotent). */
  broadcastRing(state: RingState): void;
  /** Subscribe to page events. Returns the unsubscribe. */
  onPageEvent(handler: (event: PageEvent) => void): () => void;
}

/** Which tab the user is looking at — targeting for ring/keys/ink. */
export interface SurfaceTargeting {
  activeTab(): number | undefined;
  onActiveTabChange(handler: (tab: number | undefined) => void): () => void;
  /** Identity of one tab (tab-boundary events name where the user left/went). */
  tabInfo?(tab: number): Promise<{ url?: string; title?: string } | undefined>;
}

/** A warm, held capture stream (36–48 ms shots ride it). */
export interface HeldStream {
  tab: number;
  release(): void;
}

/** One captured frame/shot, host-encoded. */
export interface PanelShot {
  width: number;
  height: number;
  mime: string;
  bytes: Uint8Array;
  /** Small data-URL preview for the engine event / preview pane. */
  thumb?: string;
}

/** Pixels: the capture half (tabCapture in MV3, getDisplayMedia elsewhere). */
export interface CaptureSource {
  /** Warm a stream for a tab; the claim holds it for the turn's life. */
  holdStream(tab: number): Promise<HeldStream>;
  /** Grab one shot off the warm stream. */
  grabShot(tab: number): Promise<PanelShot>;
}

/** The full host bundle a client is constructed over. */
export interface IntentHost {
  transport: PageTransport;
  targeting: SurfaceTargeting;
  capture: CaptureSource;
}
