/**
 * Region screenshots + the component locator.
 *
 * Capture: the browser can't screenshot itself silently, so the first shot
 * asks once via getDisplayMedia (pick this tab) and the stream is kept for the
 * session — every later shot is an instant frame-grab. Denied/unavailable
 * capture degrades gracefully: the shot event still carries the rect and the
 * located components, just no pixels. (A follow-up path can capture server-side
 * via the session browser's CDP endpoint — the channel knows it from
 * launch-info — but getDisplayMedia works everywhere with zero moving parts.)
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
import type { LocatedComponent, Rect } from "../intent-pipeline";
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
  thumb?: string,
  bytes?: Uint8Array,
) => void;

export class ShotTool {
  readonly veil: HTMLDivElement;
  private box: HTMLDivElement;
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private start: { x: number; y: number } | undefined;
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
    });
  }

  /** S held: show the crosshair veil; S released without a drag → whole viewport. */
  setArmed(on: boolean): void {
    this.veil.style.display = on ? "block" : "none";
    if (!on) {
      this.start = undefined;
      this.box.style.display = "none";
    }
  }

  dragInProgress(): boolean {
    return this.start !== undefined;
  }

  async shootViewport(): Promise<void> {
    await this.capture({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
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

  private async capture(rect: Rect): Promise<void> {
    const components = locateComponents(rect, [this.veil, this.ink.canvas]);
    const pixels = await this.grab(rect);
    this.onShot(rect, components, pixels?.thumb, pixels?.bytes);
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
    // Give the compositor a beat so the veil (display:none during S-up
    // handling) isn't in the frame.
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

/** The locator pass: rect → annotated components under it. */
export function locateComponents(rect: Rect, ignore: Element[]): LocatedComponent[] {
  if (typeof document === "undefined" || typeof document.elementsFromPoint !== "function") {
    return []; // no hit-testing available (headless/exotic) — shot degrades to rect only
  }
  const sourceRoot = typeof window === "undefined" ? undefined : window.__AIUI__?.sourceRoot;
  const found = new Map<Element, LocatedComponent>();
  const steps = 6;
  const hidden = ignore.map((el) => {
    const prev = (el as HTMLElement).style.visibility;
    (el as HTMLElement).style.visibility = "hidden";
    return () => {
      (el as HTMLElement).style.visibility = prev;
    };
  });
  try {
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const x = rect.x + (rect.w * i) / steps;
        const y = rect.y + (rect.h * j) / steps;
        for (const element of document.elementsFromPoint(x, y)) {
          const host = element.closest("[data-source-loc], [data-cell]");
          if (host && !found.has(host)) {
            const box = host.getBoundingClientRect();
            const stamp = host.getAttribute("data-source-loc") ?? undefined;
            found.set(host, {
              component: host.getAttribute("data-cell") ?? host.tagName.toLowerCase(),
              source: stamp ? absoluteSource(stamp, sourceRoot) : "unknown",
              rect: { x: box.x, y: box.y, w: box.width, h: box.height },
            });
          }
        }
      }
    }
  } finally {
    for (const restore of hidden) {
      restore();
    }
  }
  return [...found.values()];
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
