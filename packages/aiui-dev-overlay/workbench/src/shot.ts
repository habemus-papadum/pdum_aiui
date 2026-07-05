/**
 * Region screenshots + the component locator prototype.
 *
 * Capture: the browser can't screenshot itself silently, so the first shot
 * asks once via getDisplayMedia (pick this tab) and the stream is kept for
 * the session — every later shot is an instant frame-grab. Denied/unavailable
 * capture degrades gracefully: the shot event still carries the rect and the
 * located components, just no pixels. (The production path won't have this
 * problem at all: the session browser's CDP port can screenshot server-side.
 * The workbench trades that for zero moving parts.)
 *
 * Locator: sample a grid of points inside the rect, `elementsFromPoint` each,
 * walk up to the nearest `[data-source]` ancestor, dedupe. The workbench's
 * scenery annotates itself the way a locator-style vite plugin would annotate
 * a real app (`data-comp` + `data-source="file.ts:line"`), so this exercises
 * the exact mechanism screenshot-rect → components → source needs.
 */
import type { Ink } from "./ink";
import type { LocatedComponent, Rect } from "./types";

export class ShotTool {
  readonly veil: HTMLDivElement;
  private box: HTMLDivElement;
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private start: { x: number; y: number } | undefined;
  private readonly onShot: (
    rect: Rect,
    components: LocatedComponent[],
    thumb?: string,
    path?: string,
  ) => void;
  private readonly ink: Ink;

  constructor(
    ink: Ink,
    onShot: (rect: Rect, components: LocatedComponent[], thumb?: string, path?: string) => void,
  ) {
    this.ink = ink;
    this.onShot = onShot;
    this.veil = document.createElement("div");
    this.veil.className = "wb-shot-veil";
    this.box = document.createElement("div");
    this.box.className = "wb-shot-box";
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
    const thumb = await this.grabThumb(rect);
    // Persist the pixels so the lowered prompt can reference a real absolute
    // path (the Option-C contract) — best-effort; the event degrades without it.
    let path: string | undefined;
    if (thumb) {
      try {
        const bytes = await fetch(thumb).then((r) => r.blob());
        const saved = (await fetch("/api/shot", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: bytes,
        }).then((r) => r.json())) as { path?: string };
        path = saved.path;
      } catch {}
    }
    this.onShot(rect, components, thumb, path);
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

  private async grabThumb(rect: Rect): Promise<string | undefined> {
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
    // Freeze any ink inside the rect into the image — annotations travel
    // with the pixels they annotate.
    this.ink.compositeInto(ctx, rect.x, rect.y, scaleX);
    return canvas.toDataURL("image/png");
  }

  dispose(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.veil.remove();
  }
}

/** The locator pass: rect → annotated components under it. */
export function locateComponents(rect: Rect, ignore: Element[]): LocatedComponent[] {
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
          const host = element.closest("[data-source]");
          if (host && !found.has(host)) {
            const box = host.getBoundingClientRect();
            found.set(host, {
              component: host.getAttribute("data-comp") ?? host.tagName.toLowerCase(),
              source: host.getAttribute("data-source") ?? "unknown",
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
