/**
 * transport.ts — the page-transport seam (intent-client 02 §5 / 03 §4).
 *
 * Everything the client needs from "the pages it drives" fits behind three
 * small interfaces. The page-side contract is the one this package's own
 * content script serves (ext/content.ts `serveRelay` — selection, viewport,
 * pencil, keylayer, flash, …) — so the production `ExtensionBus` is the relay
 * verbatim; the `CdpBus` delivers the same capabilities over Runtime.evaluate;
 * and the `FakeBus` (./fake-bus.ts) is what every harness test drives.
 *
 * The client core never imports chrome.*, CDP, or a DOM: it talks to these
 * types only. That is the whole point — the brain is host-agnostic and
 * headless-testable, and the host is a constructor argument.
 */
import type { PageTabRecord } from "@habemus-papadum/aiui-intent-runtime";

/** The page capabilities a transport must deliver (the relay's command set). */
export type PageCapability =
  | "keylayer"
  | "flash"
  | "selection"
  | "viewport"
  /** Arm a ONE-SHOT rubber-band drag on the page (the `a` area shot). */
  | "region"
  /** Arm the ONE-SHOT jump-to-editor pick (the `j` gesture, aiui pages):
   * payload `{arm}` — click opens the in-page picker, commit opens
   * `vscode://file/…`. Fully page-side; nothing reports back. */
  | "jump"
  /** The pencil markup surface (local stylus + forwarded iPad strokes). Payload
   * is `{op, …}`: engage/disengage/fade/clear/undo, and the remote stroke ops
   * rbegin/rpoint/rend/rcancel the panel's HostSession forwards (Phase 2). A
   * `size` op returns the plane. See page/pencil-mount.ts. */
  | "pencil"
  /** Invoke one page tool from `__AIUI__.tools` (the T2 bridge): payload
   * `{ns, name, args, callId}`; the page answers with a `toolsResult`
   * page EVENT (async — the call may take a while), not a return value. */
  | "toolsCall"
  /** Driver liveness: payload `{session}` — the panel client's per-boot id,
   * beaten on a short cadence. The page's watchdog (page/driver-watch.ts)
   * self-cleans stranded assertions when the beats stop. */
  | "heartbeat";

/** How often a live driver beats the pages it can reach. */
export const HEARTBEAT_MS = 750;
/** Beat silence past this = the driver is gone (page/driver-watch.ts). Three
 * missed beats — tightened from 7000/2000 (owner, 2026-07-17: a closed panel
 * should clean its pages in seconds, not most of ten). Two things keep the
 * shorter window honest: the MV3 tier's PRIMARY close signal is the worker's
 * port verdict (sw.ts — this watchdog is its backup there), and the watch
 * skips one round after a main-thread stall (GC, debugger, heavy frame), so
 * queued beats get to land before silence convicts. */
export const DRIVER_TIMEOUT_MS = 2500;

/** The on-page indicator's asserted state (a claim's desire, as data). */
export interface RingState {
  on: boolean;
  /** The richer tone while a turn is open (turn/tweak). */
  turnTone: boolean;
  /**
   * Present when this host's capture grant is REAL (not grantless) and the
   * ring is on. `tab` is the granted tab — absent means no grant has been
   * minted yet — and `hint` is how the user mints one: the activation
   * shortcut's LIVE label, discovered by the host, never hard-coded (users
   * rebind it, and Chrome silently drops a conflicted binding). Tabs other
   * than `tab` render the HOLLOW ring with the hint (the fourth ring state,
   * BEHAVIOR.md).
   */
  grant?: { tab?: number; hint: string };
}

/** What ONE page renders — the per-tab projection of a {@link RingState}. */
export interface PageRing {
  on: boolean;
  turnTone: boolean;
  /** Outline-only: "the client is armed, but THIS tab's pixels need a grant". */
  hollow?: boolean;
  /** Rendered beside the hollow ring — how to mint the grant ("⌘B"). */
  hint?: string;
}

/** Project the ring desire onto one tab. Pure, and shared by every bus, so
 * the solid-vs-hollow decision cannot drift between hosts. */
export function ringForTab(state: RingState, tab: number): PageRing {
  const hollow = state.on && state.grant !== undefined && state.grant.tab !== tab;
  return {
    on: state.on,
    turnTone: state.turnTone,
    ...(hollow ? { hollow: true, hint: state.grant?.hint } : {}),
  };
}

/** Events pages push at the panel (the inbound half of the relay). */
export type PageEvent =
  | { kind: "selectionPresent"; tab: number; present: boolean }
  | { kind: "interaction"; tab: number }
  | { kind: "keyForward"; tab: number; key: string; phase: "down" | "up"; repeat: boolean }
  /** A same-tab navigation (SPA route, reload, hash) — context riding the
   * turn, rendered into the prompt by the wire engine. `tabRecord` is the
   * DESTINATION's canonical record (`pageTabRecord`), when the reporter could
   * build one. */
  | {
      kind: "navigation";
      tab: number;
      from: string;
      to: string;
      navKind?: "push" | "replace" | "traverse" | "reload" | "hash";
      tabRecord?: PageTabRecord;
    }
  /** The page announced whether it is aiui-INSTRUMENTED (window.__AIUI__):
   * instrumented pages can host jump-to-editor. */
  | { kind: "aiuiSupport"; tab: number; supported: boolean }
  /** The user completed a region drag (the armed `a` gesture): the rect in
   * CSS px (viewport coords), the viewport for crop scaling, the gesture's
   * wall-clock, and — on aiui-instrumented pages — the located components
   * (data-source-loc stamps) the drag framed. */
  | {
      kind: "regionDrag";
      tab: number;
      rect: { x: number; y: number; w: number; h: number };
      viewport: { w: number; h: number };
      takenAt: number;
      components?: unknown[];
    }
  /** The user finished a jump pick — committed a row (VS Code opens) or cancelled
   * (Esc / click-away). The page's completion signal that auto-exits jump mode
   * (owner, 2026-07-16); carries no payload beyond the tab. */
  | { kind: "jumpDone"; tab: number }
  /** The page's `__AIUI__.tools` registry changed: its FULL current tool set,
   * descriptors only (names/descriptions/schemas — never functions). An empty
   * `registrations` means the page has no tools (the link closes its socket). */
  | {
      kind: "pageTools";
      tab: number;
      registrations: Array<{
        ns: string;
        tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
      }>;
    }
  /** A `toolsCall`'s answer, correlated by callId. */
  | {
      kind: "toolsResult";
      tab: number;
      callId: string;
      ok: boolean;
      value?: unknown;
      error?: string;
    };

/** Tab-scoped request/response + ring broadcast + page→panel events. */
export interface PageTransport {
  /** Invoke one page capability on one tab (the relayRequestTab shape). */
  requestPage(tab: number, capability: PageCapability, payload?: unknown): Promise<unknown>;
  /** Assert the indicator ring everywhere (fire-and-forget, idempotent). */
  broadcastRing(state: RingState): void;
  /** Subscribe to page events. Returns the unsubscribe. */
  onPageEvent(handler: (event: PageEvent) => void): () => void;
}

/** Which tab the user is looking at — targeting for ring/keys/pencil. */
export interface SurfaceTargeting {
  activeTab(): number | undefined;
  onActiveTabChange(handler: (tab: number | undefined) => void): () => void;
  /**
   * Identity of one tab (tab-boundary events name where the user left/went).
   * Beyond url/title, a host contributes whatever of the canonical tab-record
   * fields live in ITS namespace — the extension its chrome ids, the CDP
   * driver its target id / driver handle — so the boundary's `<tab>` record
   * carries everything known without the host-agnostic caller guessing.
   */
  tabInfo?(
    tab: number,
  ): Promise<({ url?: string; title?: string } & Omit<PageTabRecord, "url" | "title">) | undefined>;
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
  /** Data-URL preview for the engine event / preview pane. FULL resolution for a
   * manual/area shot (so the hover peek is crisp — the same pixels as `bytes`),
   * downscaled for a video sample (a `thumbMaxPx` cap, since it rides every
   * frame). */
  thumb?: string;
}

/** Pixels: the capture half (tabCapture in MV3, getDisplayMedia elsewhere). */
export interface CaptureSource {
  /**
   * This host can capture ANY attached tab with no user grant — so there is no
   * grant to mint, and `grantedTab` simply tracks the tab in view.
   *
   * That is the CDP tier: `Page.captureScreenshot` asks nobody. MV3's
   * `tabCapture` does not — it is invocation-gated per tab, so its grant is a
   * real world fact the activation gesture mints, and the capture acts stay
   * dark until it exists. Same machine, same gates; the host decides whether
   * the fact is free.
   */
  grantless?: boolean;
  /**
   * How the user mints a grant, as a short label the page shows beside the
   * hollow ring ("⌘B"). The host discovers it live — the MV3 bus reads the
   * command's actual binding from `chrome.commands.getAll()` — so nothing
   * below the host ever knows (or hard-codes) what the key is. Gated hosts
   * only; meaningless when `grantless`.
   */
  grantHint?: string;
  /** Warm a stream for a tab; the claim holds it for the turn's life. */
  holdStream(tab: number): Promise<HeldStream>;
  /** Grab one shot off the warm stream. `opts.thumbMaxPx` caps the inline thumb's
   * longest edge — the video sampler passes it so frequent frames stay lean;
   * omitted, the thumb is FULL resolution for a crisp preview peek. Hosts may
   * ignore opts (the CDP tier's thumb is already the full screenshot). */
  grabShot(tab: number, opts?: { thumbMaxPx?: number }): Promise<PanelShot>;
  /** Crop a REGION of the tab (rect in CSS px; viewport for scale mapping).
   * Optional: hosts without it degrade to the full-frame grabShot. */
  grabRegion?(
    tab: number,
    rect: { x: number; y: number; w: number; h: number },
    viewport: { w: number; h: number },
  ): Promise<PanelShot>;
}

/** The full host bundle a client is constructed over. */
export interface IntentHost {
  transport: PageTransport;
  targeting: SurfaceTargeting;
  capture: CaptureSource;
}
