/**
 * screencast.ts — a live MediaStream of the leader tab, synthesized from CDP.
 *
 * The MV3 tier warms a real `tabCapture` MediaStream (ext/capture.ts); the CDP
 * tier has none — `Page.captureScreenshot` is one frame at a time. So for the
 * remote pencil to show the iPad a moving picture of the tab, we build the
 * stream ourselves: `Page.startScreencast` on the leader session pushes JPEG
 * frames, we paint each onto an offscreen canvas, and `canvas.captureStream()`
 * turns that canvas into the MediaStream the pencil `HostSession` feeds to
 * WebRTC. Frames are ack'd so more keep coming; the cast re-targets when the
 * leader tab changes.
 *
 * Browser-only by nature (Image decode, canvas, captureStream): it runs in the
 * standalone panel page, and its correctness is a real-browser check — there is
 * nothing meaningful to assert in jsdom (no 2D context, no captureStream).
 */

export interface ScreencastDeps {
  /** cdp.send, bound. */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** cdp.onEvent, bound — returns an unsubscribe. */
  onEvent(
    handler: (event: {
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    }) => void,
  ): () => void;
  /** The leader tab's CDP session, or undefined when nothing is attached. */
  session(): string | undefined;
  /** Fires when the leader tab changes (re-target the cast). */
  onActiveTabChange(handler: () => void): () => void;
  /** Fired once when the stream first becomes available (after the first frame
   * sizes the canvas). The panel wires this to the pencil host's `refresh`, so
   * HostSession re-offers the now-ready video to whoever joined first. */
  onReady?(): void;
  /** captureStream frame rate. Default 15 — plenty for a markup reference. */
  fps?: number;
}

export interface Screencast {
  /** The live stream, or undefined until the first frame sizes the canvas. */
  stream(): MediaStream | undefined;
  dispose(): void;
}

export function createScreencast(deps: ScreencastDeps): Screencast {
  const fps = deps.fps ?? 15;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let stream: MediaStream | undefined;
  let casting: string | undefined; // the session we've started a cast on

  const startOn = (sessionId: string): void => {
    casting = sessionId;
    void deps
      .send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }, sessionId)
      .catch(() => {});
  };
  const stopCast = (): void => {
    if (casting !== undefined) {
      void deps.send("Page.stopScreencast", {}, casting).catch(() => {});
      casting = undefined;
    }
  };

  const offEvent = deps.onEvent((event) => {
    if (event.method !== "Page.screencastFrame" || event.sessionId !== casting) {
      return;
    }
    const p = event.params as { data?: string; sessionId?: number };
    // Ack so the browser keeps sending — the frame's own id, on the cast session.
    if (p.sessionId !== undefined && casting !== undefined) {
      void deps
        .send("Page.screencastFrameAck", { sessionId: p.sessionId }, casting)
        .catch(() => {});
    }
    if (ctx === null || p.data === undefined) {
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      ctx.drawImage(img, 0, 0);
      // The first frame sizes the canvas: publish the stream and tell the host,
      // which pulled `stream()` (got undefined) when the viewer joined.
      if (stream === undefined && typeof canvas.captureStream === "function") {
        stream = canvas.captureStream(fps);
        deps.onReady?.();
      }
    };
    img.src = `data:image/jpeg;base64,${p.data}`;
  });

  const retarget = (): void => {
    // Only chase the leader while we are ALREADY casting (a viewer wants video);
    // no viewer, no cast (the CDP screencast is not free).
    if (casting !== undefined) {
      const s = deps.session();
      if (s !== casting) {
        stopCast();
        if (s !== undefined) {
          startOn(s);
        }
      }
    }
  };
  const offTab = deps.onActiveTabChange(retarget);

  return {
    stream: () => {
      // Lazy: the first pull (a viewer joined) starts the cast. The stream lands
      // a frame later, via onReady above — until then, undefined.
      if (casting === undefined) {
        const s = deps.session();
        if (s !== undefined) {
          startOn(s);
        }
      }
      return stream;
    },
    dispose: () => {
      offEvent();
      offTab();
      stopCast();
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = undefined;
    },
  };
}
