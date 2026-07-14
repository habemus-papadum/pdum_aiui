/**
 * remote-host.ts — the Lab as a pencil host: the thin, app-shaped layer over
 * the library's {@link HostSession}.
 *
 * Everything WebRTC — peers, offers, keepalive, videoStatus — lives in the
 * session (extracted FROM here; the Lab is its reference consumer). What
 * remains is exactly what an integrator would write, and it is deliberately
 * small: the two planes and how each gets its stream.
 *
 *   **canvas** — the scratchpad (use case 4). The paper streams itself
 *   (`captureStream()`, no grant), and is kept warm while watched.
 *
 *   **tab** — the page-markup application (use cases 1–2). Remote strokes land
 *   on the transparent viewport overlay; the video is
 *   `getDisplayMedia({ preferCurrentTab })`, click-gated behind {@link
 *   LabHost.shareTab}. Incoming `scroll` moves the real window and retires the
 *   overlay ink (D4).
 */

import {
  HostSession,
  type HostSessionStatus,
  hostRelayUrl,
  type PencilParams,
  type PencilSurface,
} from "@habemus-papadum/aiui-pencil";
import { durableSignal, throttled } from "@habemus-papadum/aiui-viz";

export type SharePlane = "canvas" | "tab";

export interface HostStatus {
  state: "off" | "connecting" | "hosting";
  viewers: number;
  plane: SharePlane;
  /** Tab mode only: is the `getDisplayMedia` grant in hand? */
  tabCapture: "n/a" | "needsGesture" | "active" | "denied";
}

/** The status snapshot the UI renders. Discrete events, but throttled anyway —
 * a reconnect loop must not be able to spam the graph. */
export const hostStatus = throttled(
  durableSignal<HostStatus>("host-status", {
    state: "off",
    viewers: 0,
    plane: "canvas",
    tabCapture: "n/a",
  }),
  4,
);

export interface LabHostOptions {
  /** The scratchpad plane: the Lab's real paper. */
  paper: PencilSurface;
  /** The page-markup plane: the transparent viewport overlay. */
  overlay: PencilSurface;
  /** The live brush — the Lab's knobs. */
  params: () => PencilParams;
}

export class LabHost {
  private readonly session: HostSession;
  private mode: SharePlane = "canvas";
  private canvasStream: MediaStream | undefined;
  private tabStream: MediaStream | undefined;
  private denied = false;
  private last: HostSessionStatus = { state: "off", viewers: 0, capturing: false };

  constructor(private readonly opts: LabHostOptions) {
    this.session = new HostSession({
      url: hostRelayUrl(),
      label: "pencil-lab",
      surface: () => (this.mode === "tab" ? opts.overlay : opts.paper),
      params: () => opts.params(),
      stream: () => this.currentStream(),
      streamHint: () => "click «Share this tab» in the Lab's Remote panel",
      // Canvas plane only: a still paper emits no frames; the overlay's tab
      // capture paces itself. Repainting the paper in tab mode would be wasted.
      keepWarm: () => {
        if (this.mode === "canvas") {
          opts.paper.repaint();
        }
      },
      onScroll: (du, dv) => this.applyScroll(du, dv),
      onZoom: () => {
        // Deliberately inert: browser zoom reflows the page, and D4's answer to
        // reflow is retiring the ink, not chasing it. Revisit with C4.
      },
      onStatus: (status) => {
        this.last = status;
        this.publish();
      },
    });
  }

  connect(): void {
    this.session.connect();
  }

  /** Switch which plane is shared. The session re-offers to every viewer. */
  setPlane(mode: SharePlane): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.denied = false;
    this.session.refresh();
  }

  /**
   * The human clicked "Share this tab" — click-gated because `getDisplayMedia`
   * demands transient user activation. `navigator.mediaDevices` does not even
   * EXIST outside a secure context (a LAN-IP http page!), so that failure names
   * its fix instead of stack-tracing.
   */
  async shareTab(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.denied = true;
      this.session.deny(
        window.isSecureContext
          ? "this browser has no getDisplayMedia"
          : `http://${location.host} is not a secure context — capture APIs only exist on ` +
              "localhost or https. Open the HOST page via http://localhost:5173 (the iPad's " +
              "client URL stays on the LAN IP).",
      );
      this.publish();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        // Chrome-specific, and exactly what we mean: this very tab.
        ...({ preferCurrentTab: true } as object),
      });
      this.tabStream = stream;
      this.denied = false;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        // The human hit "stop sharing" — say so, don't go silently black.
        this.tabStream = undefined;
        this.session.refresh();
      });
      this.session.refresh();
    } catch (error) {
      this.tabStream = undefined;
      this.denied = true;
      this.session.deny(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    this.publish();
  }

  dispose(): void {
    this.session.dispose();
  }

  private currentStream(): MediaStream | undefined {
    if (this.mode === "canvas") {
      this.canvasStream ??= this.opts.paper.canvas.captureStream(30);
      return this.canvasStream;
    }
    return this.tabStream;
  }

  private applyScroll(du: number, dv: number): void {
    if (this.mode !== "tab") {
      return; // the scratchpad has nothing to scroll
    }
    window.scrollBy(du * window.innerWidth, dv * window.innerHeight);
    // D4: the viewport moved, so the annotations' referents moved — retire the
    // overlay ink the intentional way. Repeated calls during a gesture just
    // keep re-arming the animation; it pops when the fingers settle.
    this.opts.overlay.clearAnimated(0.35);
  }

  private publish(): void {
    hostStatus.set({
      state: this.last.state,
      viewers: this.last.viewers,
      plane: this.mode,
      tabCapture:
        this.mode !== "tab"
          ? "n/a"
          : this.tabStream
            ? "active"
            : this.denied
              ? "denied"
              : "needsGesture",
    });
  }
}
