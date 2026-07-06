/**
 * Region screenshots + the component locator.
 *
 * Capture: the browser can't screenshot itself silently, so the first shot
 * asks once via getDisplayMedia (pick this tab) and the stream is kept for the
 * session — every later shot is an instant frame-grab. Denied/unavailable
 * capture degrades gracefully: the shot event still carries the rect and the
 * located components, just no pixels. (In the session browser there is no
 * dialog at all — it launches with --auto-accept-this-tab-capture. A
 * server-side CDP capture path was considered and rejected: see the decision
 * note in handoff/pipeline-and-interaction-model.md — this stream is also the
 * realtime submode's video source, which CDP round-trips can't be.)
 *
 * Locator: sample a grid of points inside the rect, `elementsFromPoint` each,
 * walk up to the nearest `[data-source-loc]`/`[data-cell]` ancestor, dedupe.
 * Those are the real stamps the overlay's source-locator Vite plugin emits on
 * host elements (`data-source-loc="file:line:col"` relative to the app root,
 * `data-cell="name"`) — the same handles `selection.ts` reads — so this
 * exercises the exact screenshot-rect → components → source path a real app
 * has. When `window.__AIUI__.sourceRoot` is known the stamp is resolved to an
 * absolute path (what the agent opens); otherwise the relative stamp rides
 * through and the channel resolves it.
 *
 * Unlike the workbench's prototype, no PNG is POSTed to a dev proxy: the raw
 * bytes are handed back for the modality to upload as an `intent-v1` attachment
 * frame, and the channel assigns the on-disk path.
 */
import type { LocatedCell, LocatedComponent, Rect } from "../intent-pipeline";
import type { Ink } from "./ink";

/** A captured frame: the inline preview thumbnail plus the raw PNG for upload. */
export interface ShotPixels {
  /** Data-URL thumbnail shown inline in the preview. */
  thumb: string;
  /** Raw PNG bytes — uploaded as the shot's attachment frame. */
  bytes: Uint8Array;
}

export type ShotSink = (
  rect: Rect,
  components: LocatedComponent[],
  /** True for a whole-viewport shot (no locator run, no element metadata). */
  viewport: boolean,
  thumb?: string,
  bytes?: Uint8Array,
) => void;

export class ShotTool {
  readonly veil: HTMLDivElement;
  private box: HTMLDivElement;
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private start: { x: number; y: number } | undefined;
  /**
   * True when D was released while a drag was still in flight: the disarm is
   * deferred so the in-progress pointerup can still complete its capture, and
   * only then does the veil hide itself. See {@link setArmed}.
   */
  private disarmPending = false;
  private readonly onShot: ShotSink;
  private readonly ink: Ink;

  constructor(ink: Ink, onShot: ShotSink) {
    this.ink = ink;
    this.onShot = onShot;
    this.veil = document.createElement("div");
    this.veil.className = "mm-shot-veil";
    this.box = document.createElement("div");
    this.box.className = "mm-shot-box";
    this.veil.append(this.box);

    this.veil.addEventListener("pointerdown", (e) => {
      this.veil.setPointerCapture(e.pointerId);
      this.start = { x: e.clientX, y: e.clientY };
      this.box.style.display = "block";
      this.update(e);
    });
    this.veil.addEventListener("pointermove", (e) => this.update(e));
    this.veil.addEventListener("pointerup", (e) => {
      const rect = this.currentRect(e);
      this.start = undefined;
      this.box.style.display = "none";
      if (rect && rect.w > 8 && rect.h > 8) {
        void this.capture(rect);
      }
      // If D came up mid-drag, its disarm was deferred to this pointerup so the
      // capture above could still run; hide the veil now. grab()'s compositor
      // beat lets the hide land before the frame is actually read.
      if (this.disarmPending) {
        this.hideVeil();
      }
    });
  }

  /**
   * D held: show the crosshair veil so the next drag is a region shot; D
   * released: hide it again. There is deliberately no viewport fallback here —
   * the whole-viewport shot lives on its own key (S), split off so a fast drag
   * can't also fire it (keymap.ts's header note explains the race).
   *
   * The one subtlety is disarming mid-drag: if D comes up while the pointer is
   * still down, hiding the veil now would clear `start` and drop the region the
   * user is drawing. So we defer via {@link disarmPending} and let that drag's
   * own pointerup finish the capture and then hide the veil.
   */
  setArmed(on: boolean): void {
    if (on) {
      this.disarmPending = false;
      this.veil.style.display = "block";
      return;
    }
    if (this.dragInProgress()) {
      this.disarmPending = true; // hide once the in-flight pointerup lands
      return;
    }
    this.hideVeil();
  }

  private hideVeil(): void {
    this.veil.style.display = "none";
    this.start = undefined;
    this.box.style.display = "none";
    this.disarmPending = false;
  }

  dragInProgress(): boolean {
    return this.start !== undefined;
  }

  /** Whether a display-capture grant is live (a shot would capture pixels). */
  hasCaptureGrant(): boolean {
    return this.video !== undefined;
  }

  /**
   * The live display-capture `<video>`, acquiring the one-time grant if needed.
   * The realtime submode's ~1 fps video sampler draws from the SAME stream shots
   * grab from — one grant serves both — so this exposes it without disturbing
   * the shot flow (it only ensures/returns the shared element). Returns
   * `undefined` when capture is denied or unavailable; sampling then simply
   * doesn't run.
   */
  ensureCaptureStream(): Promise<HTMLVideoElement | undefined> {
    return this.ensureStream();
  }

  async shootViewport(): Promise<void> {
    // Deliberately no locator: "the whole viewport" frames everything, so
    // element metadata adds bulk without a reference point (and skipping the
    // lookup keeps S instant).
    await this.capture({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, true);
  }

  private update(e: PointerEvent): void {
    const rect = this.currentRect(e);
    if (rect) {
      this.box.style.left = `${rect.x}px`;
      this.box.style.top = `${rect.y}px`;
      this.box.style.width = `${rect.w}px`;
      this.box.style.height = `${rect.h}px`;
    }
  }

  private currentRect(e: PointerEvent): Rect | undefined {
    if (!this.start) {
      return undefined;
    }
    const x = Math.min(this.start.x, e.clientX);
    const y = Math.min(this.start.y, e.clientY);
    return { x, y, w: Math.abs(e.clientX - this.start.x), h: Math.abs(e.clientY - this.start.y) };
  }

  private async capture(rect: Rect, viewport = false): Promise<void> {
    const components = viewport ? [] : locateComponents(rect);
    const pixels = await this.grab(rect);
    this.onShot(rect, components, viewport, pixels?.thumb, pixels?.bytes);
  }

  private async ensureStream(): Promise<HTMLVideoElement | undefined> {
    if (this.video) {
      return this.video;
    }
    try {
      // preferCurrentTab is a Chrome hint — exactly the browser this targets.
      this.stream = await (
        navigator.mediaDevices as MediaDevices & {
          getDisplayMedia(o?: object): Promise<MediaStream>;
        }
      ).getDisplayMedia({ video: true, preferCurrentTab: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = this.stream;
      video.muted = true;
      await video.play();
      this.video = video;
      this.stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        this.video = undefined;
        this.stream = undefined;
      });
      return video;
    } catch {
      return undefined; // denied or unsupported — shots continue without pixels
    }
  }

  private async grab(rect: Rect): Promise<ShotPixels | undefined> {
    const video = await this.ensureStream();
    if (!video) {
      return undefined;
    }
    // Give the compositor a beat so the veil (hidden as D comes up, or right
    // after this drag's pointerup) isn't in the frame.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.w * scaleX));
    canvas.height = Math.max(1, Math.round(rect.h * scaleY));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return undefined;
    }
    ctx.drawImage(
      video,
      rect.x * scaleX,
      rect.y * scaleY,
      rect.w * scaleX,
      rect.h * scaleY,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    // Freeze any ink inside the rect into the image — annotations travel with
    // the pixels they annotate.
    this.ink.compositeInto(ctx, rect.x, rect.y, scaleX);
    const thumb = canvas.toDataURL("image/png");
    const bytes = await canvasPngBytes(canvas);
    return bytes ? { thumb, bytes } : undefined;
  }

  dispose(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.veil.remove();
  }
}

/** PNG bytes from a canvas via toBlob (preferred) with a data-URL fallback. */
function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(dataUrlToBytes(canvas.toDataURL("image/png")));
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(undefined);
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(() => resolve(undefined));
    }, "image/png");
  });
}

/**
 * JPEG bytes from a canvas via toBlob (preferred) with a data-URL fallback —
 * the realtime submode's video sampler encodes its ~1 fps frames this way (the
 * shot path stays PNG via {@link canvasPngBytes}; JPEG is small enough for a
 * stream and legible enough to ground on).
 */
export function canvasJpegBytes(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(dataUrlToBytes(canvas.toDataURL("image/jpeg", quality)));
      return;
    }
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(undefined);
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(() => resolve(undefined));
      },
      "image/jpeg",
      quality,
    );
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array | undefined {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) {
    return undefined;
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Border slack for containment tests: a drag rarely lands pixel-perfect. */
const ENCLOSE_TOLERANCE = 2;

/**
 * The locator pass: rect → the components the user *framed*.
 *
 * Earlier versions grid-sampled `elementsFromPoint` and reported every
 * annotated ancestor the rect touched — which put the app shell in every
 * shot's metadata (a rect anywhere intersects it). What the prompt actually
 * needs is a point of reference, not an inventory, so:
 *
 *  1. Keep the **highest annotated elements fully enclosed** by the rect
 *     (±{@link ENCLOSE_TOLERANCE}px): of the enclosed elements, drop any
 *     contained in another — the survivors are what the drag deliberately
 *     framed.
 *  2. If the rect encloses nothing annotated — a drag *inside* one big
 *     component — fall back to the **innermost annotated element containing
 *     the rect**, marked `containment: "within"`; one element, the smallest
 *     answer to "where is this?".
 *  3. For each kept element, surface its **direct-cell frontier**: the topmost
 *     `data-cell` descendants with no other cell between them and the element.
 *     One level deep on purpose — cells mirror the dataflow graph, and the
 *     frontier names are enough for an agent to enter it; enumerating the
 *     whole subtree would bury the reference points it exists to provide.
 */
export function locateComponents(rect: Rect): LocatedComponent[] {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return []; // no DOM (headless/exotic) — shot degrades to rect only
  }
  const sourceRoot = typeof window === "undefined" ? undefined : window.__AIUI__?.sourceRoot;
  const annotated = [...document.querySelectorAll("[data-source-loc], [data-cell]")];

  const enclosed = annotated.filter((el) => {
    const box = el.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left >= rect.x - ENCLOSE_TOLERANCE &&
      box.top >= rect.y - ENCLOSE_TOLERANCE &&
      box.right <= rect.x + rect.w + ENCLOSE_TOLERANCE &&
      box.bottom <= rect.y + rect.h + ENCLOSE_TOLERANCE
    );
  });
  // Highest-first: drop anything another enclosed element already contains.
  let kept = enclosed.filter((el) => !enclosed.some((other) => other !== el && other.contains(el)));
  let containment: LocatedComponent["containment"];

  if (kept.length === 0) {
    // Nothing framed — anchor to the innermost annotated container instead.
    const containing = annotated.filter((el) => {
      const box = el.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.left <= rect.x + ENCLOSE_TOLERANCE &&
        box.top <= rect.y + ENCLOSE_TOLERANCE &&
        box.right >= rect.x + rect.w - ENCLOSE_TOLERANCE &&
        box.bottom >= rect.y + rect.h - ENCLOSE_TOLERANCE
      );
    });
    const innermost = containing.find((el) => !containing.some((o) => o !== el && el.contains(o)));
    kept = innermost ? [innermost] : [];
    containment = "within";
  }

  return kept.map((host) => {
    const box = host.getBoundingClientRect();
    const stamp = host.getAttribute("data-source-loc") ?? undefined;
    const cells = cellFrontier(host, sourceRoot);
    return {
      component: host.getAttribute("data-cell") ?? host.tagName.toLowerCase(),
      source: stamp ? absoluteSource(stamp, sourceRoot) : "unknown",
      rect: { x: box.x, y: box.y, w: box.width, h: box.height },
      ...(cells.length > 0 ? { cells } : {}),
      ...(containment !== undefined ? { containment } : {}),
    };
  });
}

/**
 * The direct-cell frontier under `host`: `data-cell` descendants with no
 * other `data-cell` element strictly between them and `host`.
 */
function cellFrontier(host: Element, sourceRoot: string | undefined): LocatedCell[] {
  const frontier: LocatedCell[] = [];
  for (const el of host.querySelectorAll("[data-cell]")) {
    let between = el.parentElement;
    let shadowed = false;
    while (between && between !== host) {
      if (between.hasAttribute("data-cell")) {
        shadowed = true;
        break;
      }
      between = between.parentElement;
    }
    if (shadowed) {
      continue;
    }
    const name = el.getAttribute("data-cell");
    if (!name) {
      continue;
    }
    // A cell element usually carries no stamp of its own (the source-locator
    // stamps JSX host elements; `data-cell` comes from the dataflow runtime).
    // Fall back to the first stamped element *inside* the cell: that is where
    // the cell's UI is authored — an approximation, but exactly the file an
    // agent should open first for "this cell".
    const stamp =
      el.getAttribute("data-source-loc") ??
      el.querySelector("[data-source-loc]")?.getAttribute("data-source-loc");
    frontier.push({ name, ...(stamp ? { source: absoluteSource(stamp, sourceRoot) } : {}) });
  }
  return frontier;
}

/**
 * Resolve a `data-source-loc` stamp (`file:line:col`, app-root-relative) to an
 * absolute `sourceRoot/file:line:col` when the root is known, else pass the
 * relative stamp through for the channel to resolve.
 */
function absoluteSource(stamp: string, root: string | undefined): string {
  if (!root) {
    return stamp;
  }
  return root.endsWith("/") ? `${root}${stamp}` : `${root}/${stamp}`;
}
