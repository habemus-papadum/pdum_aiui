/** Display effects and optional expiry, independent of canvas painting. */
import type { InkDocument, InkStroke } from "./document";
import { crossfadeStyle, type FadeStyle, FULL_STYLE, fadeStyle, INK_HOLD } from "./fade";

export interface InkPresentationOptions {
  durationMs?: number;
  curve?: "warp" | "crossfade";
  expire?: boolean;
  now?: () => number;
}

interface Exit {
  revision: number;
  start: number;
  duration: number;
  remove: boolean;
}

/** Fading changes appearance. Expiry is an explicit working-document policy. */
export class InkPresentation {
  private options: InkPresentationOptions;
  private exits = new Map<string, Exit>();
  /** A completed display lifetime stays completed even when fade controls change. */
  private faded = new WeakSet<InkStroke>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: () => void;
  private disposed = false;

  constructor(
    readonly document: InkDocument,
    options: InkPresentationOptions = {},
  ) {
    this.options = { ...options };
    this.unsubscribe = document.subscribe((change) => {
      if (change.kind !== "append" && change.kind !== "begin" && change.kind !== "cancel")
        this.changed();
    });
    this.schedule();
  }

  now(): number {
    return this.options.now?.() ?? performance.now();
  }

  configure(options: InkPresentationOptions): void {
    // Account for elapsed time under the previous settings even if the browser
    // has delayed our timer (for example, while the tab was in the background).
    this.completeFades(this.now());
    this.options = { ...this.options, ...options };
    this.changed();
  }

  style(stroke: InkStroke, at = this.now()): FadeStyle {
    if (this.faded.has(stroke)) return { ...FULL_STYLE, alpha: 0 };
    const exit = this.exits.get(stroke.id);
    if (exit && exit.revision === stroke.revision) {
      if (exit.duration <= 0) return { ...FULL_STYLE, alpha: 0 };
      const total = exit.duration / (1 - INK_HOLD);
      return fadeStyle(at - exit.start + total * INK_HOLD, total);
    }
    const curve = this.options.curve === "crossfade" ? crossfadeStyle : fadeStyle;
    return curve(at - stroke.endedAt, this.options.durationMs ?? 0);
  }

  animating(at = this.now()): boolean {
    return this.document.snapshot().strokes.some((stroke) => {
      const exit = this.exits.get(stroke.id);
      return (
        (exit?.revision === stroke.revision || (this.options.durationMs ?? 0) > 0) &&
        this.style(stroke, at).alpha > 0
      );
    });
  }

  /** Fade a fixed capture; newer or subsequently edited records are untouched. */
  fadeOut(capture = this.document.capture(), durationMs = 500, remove = true): void {
    this.completeFades(this.now());
    const current = new Map(this.document.snapshot().strokes.map((stroke) => [stroke.id, stroke]));
    for (const stroke of capture.strokes) {
      // A capture from another document (or an older revision) must not remove this ink.
      if (current.get(stroke.id) !== stroke) continue;
      this.exits.set(stroke.id, {
        revision: stroke.revision,
        start: this.now(),
        duration: Math.max(0, durationMs),
        remove,
      });
    }
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  private changed(): void {
    if (this.disposed) return;
    this.schedule();
    for (const listener of this.listeners) listener();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let next = Number.POSITIVE_INFINITY;
    const strokes = this.document.snapshot().strokes;
    this.completeFades(this.now());
    const present = new Set(strokes.map((stroke) => stroke.id));
    for (const id of this.exits.keys()) if (!present.has(id)) this.exits.delete(id);
    for (const stroke of strokes) {
      const completion = this.completion(stroke);
      if (completion && (completion.remove || !this.faded.has(stroke)))
        next = Math.min(next, completion.at);
    }
    if (Number.isFinite(next))
      this.timer = setTimeout(() => this.expire(), Math.max(0, next - this.now()));
  }

  private expire(): void {
    this.timer = undefined;
    const at = this.now();
    this.completeFades(at);
    const ids = this.document
      .snapshot()
      .strokes.filter((stroke) => {
        const completion = this.completion(stroke);
        return completion?.remove && at >= completion.at;
      })
      .map((stroke) => stroke.id);
    if (ids.length) this.document.discard(ids);
    this.changed();
  }

  private completion(stroke: InkStroke): { at: number; remove: boolean } | undefined {
    const exit = this.exits.get(stroke.id);
    if (exit?.revision === stroke.revision)
      return { at: exit.start + exit.duration, remove: exit.remove };
    const duration = this.options.durationMs ?? 0;
    if (duration > 0)
      return { at: stroke.endedAt + duration, remove: this.options.expire ?? false };
    return undefined;
  }

  private completeFades(at: number): void {
    for (const stroke of this.document.snapshot().strokes) {
      const completion = this.completion(stroke);
      if (completion && at >= completion.at) this.faded.add(stroke);
    }
  }
}

export function createInkPresentation(
  document: InkDocument,
  options?: InkPresentationOptions,
): InkPresentation {
  return new InkPresentation(document, options);
}
