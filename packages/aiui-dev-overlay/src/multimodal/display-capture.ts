/**
 * The document's **one** display-capture grant.
 *
 * `getDisplayMedia` is not a permission. Chrome never persists it, and
 * `navigator.permissions.query({ name: "display-capture" })` answers `"prompt"`
 * forever, in every browser. What a successful call returns is a `MediaStream`
 * owned by a single *document* — and two calls in one document return two
 * independent live streams. That is why the shot tool and the paint host, each
 * asking for its own, produced two pickers, two capture indicators, and two
 * focus excursions for one screen. This module is the only asker; the shot
 * tool, the realtime video sampler, and the paint host all read its stream.
 *
 * Two measured facts about the browser shape the surface:
 *
 * **1. Every call blurs the window.** `blur` fires, then `focus`, even when the
 * grant is auto-accepted and no dialog is ever drawn (`visibilitychange` never
 * fires at all). Nothing distinguishes that blur from the user alt-tabbing
 * away — and the modality's blur handler stops the microphone, because a mic
 * left open on another window once transcribed an entire conversation onto the
 * API bill. So the first screenshot silently dropped the user out of hands-free
 * mode. {@link DisplayCapture.blurIsSelfInflicted} is how the handler tells the
 * two apart.
 *
 * **2. Whether a call needs a click is a property of the BROWSER, not the page,
 * and it cannot be probed.** The session browser launches with
 * `--auto-accept-this-tab-capture`, where the call resolves in ~320ms with no
 * transient activation at all. A browser without that flag opens the share
 * picker and the promise *hangs* until a human answers — it never rejects, and
 * there is no `AbortSignal`. "Try it and see" is therefore not an available
 * design: a wrong guess is a dialog you cannot take back. Instead `aiui vite`
 * speaks CDP to the browser it launched and defines
 * `window.__AIUI_CAPTURE__ = "auto"` in every document there (aiui-util's
 * capture-marker module; `chrome.autoCapture` opts out).
 *
 * Marker present → {@link DisplayCapture.prewarm} takes the grant the moment
 * the intent tool is armed. Marker absent → wait for a real click, exactly as
 * before, and the paint host keeps its "Share screen with iPad" button for
 * supplying one. Either way the grant is acquired at most once.
 *
 * The full story, including the measurements: docs/guide/screen-capture.md.
 */

/**
 * How this document may acquire capture. `"auto"` means the browser
 * auto-accepts (see the capture marker); `"gesture"` means a picker will open
 * and a transient user activation is required to even ask.
 */
export type CapturePolicy = "auto" | "gesture";

/**
 * The outcome of an acquisition. Deliberately the same three names
 * `aiui-paint`'s `CaptureState` uses, minus `"idle"`, so the paint host's
 * state machine can consume this one unchanged.
 */
export type CaptureOutcome = "active" | "needsGesture" | "denied";

/** Injected in tests; each defaults to the real browser API. */
export interface DisplayCaptureDeps {
  /** `navigator.mediaDevices.getDisplayMedia`, or undefined where unsupported. */
  getDisplayMedia?: ((options: object) => Promise<MediaStream>) | undefined;
  /** `navigator.userActivation.isActive`, or undefined when the API is absent. */
  userActivation?: () => boolean | undefined;
  /** The capture policy; defaults to reading `window.__AIUI_CAPTURE__`. */
  policy?: () => CapturePolicy;
  now?: () => number;
}

export interface DisplayCapture {
  /** Whether this browser auto-accepts capture (see the module doc). */
  policy(): CapturePolicy;
  /**
   * Acquire the document's grant, or hand back the one already held.
   * Single-flight: concurrent callers share one `getDisplayMedia` call.
   */
  acquire(): Promise<CaptureOutcome>;
  /**
   * Fire-and-forget acquisition for the `"auto"` policy — the reconciler's
   * "armed ⇒ the grant is warm" invariant. A no-op under `"gesture"` (which
   * would open a picker nobody asked for), while a call is in flight, and once
   * the grant is live.
   */
  prewarm(): void;
  /** Whether a live grant exists (a shot would capture pixels). */
  active(): boolean;
  /** The playing `<video>` backed by the grant, or undefined. */
  video(): HTMLVideoElement | undefined;
  /** The grant itself — WebRTC adds its tracks to a peer connection. */
  stream(): MediaStream | undefined;
  /** The last acquisition failure, verbatim (`"NotAllowedError: …"`). */
  lastError(): string | undefined;
  /**
   * True when the window blur happening right now is one WE caused by calling
   * `getDisplayMedia`, rather than the user leaving. Read it before tearing
   * anything down on blur.
   */
  blurIsSelfInflicted(): boolean;
  /** Release the grant. The page's business, not any one consumer's. */
  dispose(): void;
}

/**
 * How long after a `getDisplayMedia` call settles its blur/focus pair may still
 * be arriving. The events are dispatched within a frame or two of the call in
 * practice; the window is generous because the cost of being wrong the other
 * way (mistaking our own blur for the user leaving) is a dropped hands-free
 * session, while the cost of over-suppressing is one alt-tab whose mic keeps
 * listening for another quarter second.
 */
const SELF_BLUR_GRACE_MS = 750;

/** The default policy: whatever `aiui`'s CDP marker put on the window. */
function markerPolicy(): CapturePolicy {
  return typeof window !== "undefined" && window.__AIUI_CAPTURE__ === "auto" ? "auto" : "gesture";
}

function browserGetDisplayMedia(): ((options: object) => Promise<MediaStream>) | undefined {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const fn = (media as (MediaDevices & { getDisplayMedia?: unknown }) | undefined)?.getDisplayMedia;
  return typeof fn === "function"
    ? (options: object) => (fn as (o: object) => Promise<MediaStream>).call(media, options)
    : undefined;
}

function browserUserActivation(): boolean | undefined {
  const activation = typeof navigator === "undefined" ? undefined : navigator.userActivation;
  return activation ? activation.isActive : undefined;
}

export function createDisplayCapture(deps: DisplayCaptureDeps = {}): DisplayCapture {
  const policy = deps.policy ?? markerPolicy;
  const userActivation = deps.userActivation ?? browserUserActivation;
  const now = deps.now ?? Date.now;

  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  let error: string | undefined;
  let inflight: Promise<CaptureOutcome> | undefined;
  /** Blurs before this instant are ours. `Infinity` while a call is in flight. */
  let graceUntil = 0;

  async function open(): Promise<CaptureOutcome> {
    // Resolved per call, not once: tests replace navigator.mediaDevices between
    // mounts, and a browser without the API should keep reporting "denied"
    // rather than being decided at construction.
    const getDisplayMedia = deps.getDisplayMedia ?? browserGetDisplayMedia();
    if (!getDisplayMedia) {
      error = "getDisplayMedia is unavailable here";
      return "denied";
    }
    try {
      // preferCurrentTab is a Chrome hint — exactly the browser this targets —
      // and tab capture, unlike screen capture, needs no OS-level grant.
      const acquired = await getDisplayMedia({ video: true, preferCurrentTab: true, audio: false });
      const el = document.createElement("video");
      el.srcObject = acquired;
      el.muted = true;
      await el.play();
      stream = acquired;
      video = el;
      error = undefined;
      acquired.getVideoTracks()[0]?.addEventListener("ended", () => {
        // The user hit Chrome's "Stop sharing". The next acquire() asks again.
        stream = undefined;
        video = undefined;
      });
      return "active";
    } catch (caught) {
      // Keep the real reason. A NotAllowedError is the user dismissing the
      // picker; a NotReadableError with no picker shown is an environment bug
      // (browser flags, a missing OS screen-recording grant) — the difference
      // is exactly what someone debugging "share does nothing" needs to see.
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      // With the activation API we know the attempt itself was refused. Without
      // it we cannot tell a stale-gesture rejection from a refusal, so a retry
      // behind a fresh click is worth offering.
      return userActivation() === undefined ? "needsGesture" : "denied";
    }
  }

  function acquire(): Promise<CaptureOutcome> {
    if (video) {
      return Promise.resolve("active");
    }
    if (inflight) {
      return inflight;
    }
    if (policy() === "gesture" && userActivation() === false) {
      // No activation and a picker on the other side: asking would throw at
      // best. Say what the caller must arrange instead.
      return Promise.resolve("needsGesture");
    }
    graceUntil = Number.POSITIVE_INFINITY;
    inflight = open().finally(() => {
      inflight = undefined;
      graceUntil = now() + SELF_BLUR_GRACE_MS;
    });
    return inflight;
  }

  return {
    policy,
    acquire,
    prewarm() {
      if (policy() === "auto" && !video && !inflight) {
        void acquire();
      }
    },
    active: () => video !== undefined,
    video: () => video,
    stream: () => stream,
    lastError: () => error,
    blurIsSelfInflicted: () => now() < graceUntil,
    dispose() {
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
      stream = undefined;
      video = undefined;
    },
  };
}

// ── the aiui-paint adapter ───────────────────────────────────────────────────

/** Longest edge (CSS px) a streamed paint frame is downscaled to. */
const MAX_FRAME_EDGE = 1280;
const FRAME_JPEG_QUALITY = 0.6;

/**
 * The shape `aiui-paint`'s `startPaintHost({ frameSource })` consumes. Declared
 * structurally rather than imported so this module stays free of the paint
 * package (the two agree by shape across `window.__AIUI__`, exactly like the
 * remote-ink seam — see instrumentation.ts).
 */
export interface CaptureFrameSource {
  start(): Promise<CaptureOutcome>;
  lastError(): string | undefined;
  capture(): Promise<Uint8Array | undefined>;
  stream(): MediaStream | undefined;
  stop(): void;
}

/**
 * Present the broker as a paint `FrameSource`, so the iPad's video rides the
 * SAME grant the screenshots use. In the session browser that means the "Share
 * screen with iPad" button never appears: `start()` resolves `"active"` off the
 * network event that a viewer joined, with no gesture and no picker.
 *
 * `stop()` is deliberately inert. The paint host stops its frame source when it
 * closes, but the grant belongs to the document — the shot tool is still
 * holding it — so only {@link DisplayCapture.dispose} may end it.
 */
export function paintFrameSource(
  capture: DisplayCapture,
  toJpeg: (canvas: HTMLCanvasElement, quality: number) => Promise<Uint8Array | undefined>,
): CaptureFrameSource {
  return {
    start: () => capture.acquire(),
    lastError: () => capture.lastError(),
    stream: () => capture.stream(),
    stop: () => {},
    async capture() {
      const video = capture.video();
      if (!video) {
        return undefined; // grant lost mid-stream — skip this frame
      }
      const vw = video.videoWidth || window.innerWidth;
      const vh = video.videoHeight || window.innerHeight;
      const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(vw, vh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vw * scale));
      canvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return undefined;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return toJpeg(canvas, FRAME_JPEG_QUALITY);
    },
  };
}
