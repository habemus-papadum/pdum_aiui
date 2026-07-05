/**
 * The page-side player for server-pushed `speech` clips — the premium tier's
 * spoken TTS acks and the flagship tier's model replies (streaming-turns.md §4,
 * model-tiers.md T2/T3). The channel synthesizes audio and pushes it base64 in a
 * `speech` message; this plays it.
 *
 * Deliberately tiny: clips queue and play **one at a time** from a `data:` URL
 * (so there is no object-URL bookkeeping), and {@link SpeechPlayer.bargeIn} —
 * called on `talk-start` — stops the current clip and drops the queue so the
 * human talking over a reply cuts it off (the channel cancels the upstream
 * response in parallel). The audio element is injectable so jsdom tests (which
 * can't actually play) supply a fake. Framework-free, browser-safe.
 */

/** One clip to play, as it arrives on the `speech` message. */
export interface SpeechClip {
  id: string;
  /** Container MIME (e.g. `audio/mpeg` for TTS acks, `audio/wav` for voice). */
  mime: string;
  /** Base64-encoded audio bytes. */
  data: string;
  /** The spoken text, when known (shown in the widget's speaker line). */
  label?: string;
}

/** The minimal HTMLAudioElement surface the player drives — injectable for jsdom. */
export interface SpeechAudioElement {
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: "ended" | "error", listener: () => void): void;
}

/** Build an audio element from a media `src` (default: `new Audio(src)`). */
export type SpeechAudioFactory = (src: string) => SpeechAudioElement;

export interface SpeechPlayerOptions {
  /** Build the audio element (default `new Audio(src)`); injected in tests. */
  createAudio?: SpeechAudioFactory;
  /** Notified when a clip starts playing (its label — for the widget indicator). */
  onSpeak?: (label: string | undefined) => void;
  /** Notified when the queue drains (clears the indicator). */
  onIdle?: () => void;
}

const defaultCreateAudio: SpeechAudioFactory = (src) => new Audio(src);

/** A serial audio player for `speech` clips, with `talk-start` barge-in. */
export class SpeechPlayer {
  private queue: SpeechClip[] = [];
  private current: SpeechAudioElement | undefined;
  private playing = false;
  private readonly createAudio: SpeechAudioFactory;

  constructor(private readonly opts: SpeechPlayerOptions = {}) {
    this.createAudio = opts.createAudio ?? defaultCreateAudio;
  }

  /** Queue a clip; starts playback if the player is idle. */
  enqueue(clip: SpeechClip): void {
    this.queue.push(clip);
    if (!this.playing) {
      this.playNext();
    }
  }

  private playNext(): void {
    const clip = this.queue.shift();
    if (clip === undefined) {
      this.playing = false;
      this.current = undefined;
      this.opts.onIdle?.();
      return;
    }
    this.playing = true;
    this.opts.onSpeak?.(clip.label);
    const audio = this.createAudio(`data:${clip.mime};base64,${clip.data}`);
    this.current = audio;
    // Advance only if this clip is still the current one (a barge-in in between
    // detaches it, so a late `ended`/`error` doesn't resurrect the queue).
    const advance = (): void => {
      if (this.current === audio) {
        this.playNext();
      }
    };
    audio.addEventListener("ended", advance);
    audio.addEventListener("error", advance);
    try {
      const result = audio.play();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => advance());
      }
    } catch {
      advance();
    }
  }

  /** Barge-in: stop the current clip and drop the queue (talk-start). */
  bargeIn(): void {
    this.queue = [];
    if (this.current) {
      try {
        this.current.pause();
      } catch {
        // best-effort — the element may already be stopped
      }
    }
    this.current = undefined;
    this.playing = false;
    this.opts.onIdle?.();
  }

  /** True while a clip is playing or queued (for the report/indicator). */
  get active(): boolean {
    return this.playing;
  }

  dispose(): void {
    this.bargeIn();
  }
}
