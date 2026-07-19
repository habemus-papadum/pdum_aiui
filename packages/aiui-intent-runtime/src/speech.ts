/**
 * The page-side player for server-pushed `speech` audio — two shapes:
 *
 *  - **Whole clips** (the premium tier's TTS acks): queue and play one at a
 *    time from a `data:` URL, as ever.
 *  - **Streamed PCM chunks** (model replies — linter notes, oracle turns):
 *    `seq`-ordered raw PCM16 frames sharing a stream id, scheduled GAPLESSLY
 *    through one Web Audio context the moment they arrive. Streaming playback
 *    is the contract (whole-clip reply buffering retired 2026-07-19 — it
 *    delayed the first audible byte by the entire reply's generation time).
 *
 * {@link SpeechPlayer.bargeIn} — called on `talk-start` — silences everything
 * (clips and streams) so the human talking over a reply cuts it off; a
 * server-pushed `speech-cancel` stops one stream by id (the vendor's own
 * barge-in, relayed). The audio element and the audio context are injectable
 * so jsdom tests supply fakes. Framework-free, browser-safe.
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

/** One streamed PCM chunk, as it arrives on a `speech` message with `seq`. */
export interface SpeechChunk {
  id: string;
  /** `audio/pcm;rate=NNN` — raw PCM16 mono; rate parsed from the MIME. */
  mime: string;
  /** Base64-encoded PCM16 bytes. */
  data: string;
  /** 0-based order under `id`. */
  seq: number;
}

/** The minimal Web Audio surface the streaming path drives — injectable for jsdom. */
export interface PcmContextLike {
  currentTime: number;
  state?: string;
  resume?(): Promise<void> | void;
  destination: unknown;
  createBuffer(
    channels: number,
    frames: number,
    rate: number,
  ): { getChannelData(ch: number): Float32Array; duration: number };
  createBufferSource(): {
    buffer: unknown;
    connect(dest: unknown): void;
    start(when?: number): void;
    stop(): void;
    onended: (() => void) | null;
  };
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
  /** Build the Web Audio context for streamed PCM (default `new AudioContext()`). */
  createContext?: () => PcmContextLike;
  /** Notified when a clip starts playing (its label — for the widget indicator). */
  onSpeak?: (label: string | undefined) => void;
  /** Notified when the queue drains (clears the indicator). */
  onIdle?: () => void;
  /**
   * Playback was refused by the browser's autoplay policy (`NotAllowedError`):
   * the document has never seen a user gesture. The clip is PARKED, not
   * dropped — the player resumes it on the next pointerdown/keydown in this
   * document. Fired once per blocked stretch: surface a visible hint ("click
   * anywhere to hear it"). A player living in the page the user is actively
   * touching never needs this, but the intent client's PANELS do: with keys
   * forwarded from the target tab, the panel document itself may never have
   * been touched when the first linter clip arrives.
   */
  onBlocked?: () => void;
}

const defaultCreateAudio: SpeechAudioFactory = (src) => new Audio(src);

/** A serial audio player for `speech` clips + gapless streamed PCM, with barge-in. */
export class SpeechPlayer {
  private queue: SpeechClip[] = [];
  private current: SpeechAudioElement | undefined;
  private playing = false;
  private blocked = false;
  private unlockArmed = false;
  private readonly createAudio: SpeechAudioFactory;

  // ── the streamed-PCM lane (one active reply stream at a time) ─────────────
  private ctx: PcmContextLike | undefined;
  private streamId: string | undefined;
  /** Where the next chunk is scheduled to begin (gapless back-to-back). */
  private nextTime = 0;
  /** Sources still scheduled/playing for the CURRENT stream (cancel stops them). */
  private streamSources: Array<{ stop(): void }> = [];
  private streamOutstanding = 0;

  constructor(private readonly opts: SpeechPlayerOptions = {}) {
    this.createAudio = opts.createAudio ?? defaultCreateAudio;
  }

  /**
   * Schedule one streamed PCM chunk the moment it arrives. A chunk with a NEW
   * id starts a fresh stream (the previous one has ended upstream — its tail
   * plays out); chunks share the context and schedule back-to-back for
   * gapless playback. If the context is suspended (autoplay policy: no
   * gesture yet in this document), a resume is requested and re-armed on the
   * next gesture — scheduled audio then plays from the resume.
   */
  feedChunk(chunk: SpeechChunk): void {
    if (this.ctx === undefined) {
      this.ctx =
        this.opts.createContext?.() ??
        new (globalThis as { AudioContext: new () => PcmContextLike }).AudioContext();
    }
    const ctx = this.ctx;
    if (ctx.state === "suspended") {
      void ctx.resume?.();
      this.armUnlock();
      if (!this.blocked) {
        this.blocked = true;
        this.opts.onBlocked?.();
      }
    }
    if (chunk.id !== this.streamId) {
      // A new reply: fresh stream state. The old stream's sources are left to
      // finish naturally (its chunks stopped arriving when it completed).
      this.streamId = chunk.id;
      this.nextTime = 0;
      this.streamSources = [];
      if (this.streamOutstanding === 0) {
        this.opts.onSpeak?.(undefined); // the speaking indicator, text unknown yet
      }
    }
    const rate = Number(/rate=(\d+)/.exec(chunk.mime)?.[1] ?? 24000);
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    if (samples.length === 0) {
      return;
    }
    const buffer = ctx.createBuffer(1, samples.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    this.nextTime = Math.max(ctx.currentTime, this.nextTime);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.streamSources.push(source);
    this.streamOutstanding += 1;
    source.onended = () => {
      this.streamOutstanding -= 1;
      if (this.streamOutstanding === 0 && !this.playing) {
        this.opts.onIdle?.();
      }
    };
  }

  /** Server-relayed barge-in (`speech-cancel`): stop playing stream `id` NOW. */
  cancelStream(id: string): void {
    if (id !== this.streamId) {
      return; // an older stream — its sources already drained or were replaced
    }
    for (const source of this.streamSources) {
      try {
        source.stop();
      } catch {
        // best-effort — a source that already ended throws in some engines
      }
    }
    this.streamSources = [];
    this.streamId = undefined;
    this.nextTime = 0;
  }

  /** Queue a clip; starts playback if the player is idle. */
  enqueue(clip: SpeechClip): void {
    this.queue.push(clip);
    if (!this.playing && !this.blocked) {
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
        (result as Promise<void>).catch((error: unknown) => {
          // The autoplay policy (no user gesture yet in THIS document) is the
          // one refusal worth waiting out: park the clip and resume on the
          // next gesture. Anything else (decode failure, bad data) advances —
          // replaying it on a gesture would just fail again.
          if ((error as { name?: string } | null)?.name === "NotAllowedError") {
            this.park(clip, audio);
          } else {
            advance();
          }
        });
      }
    } catch {
      advance();
    }
  }

  /** Autoplay refused: put the clip back at the head and wait for a gesture. */
  private park(clip: SpeechClip, audio: SpeechAudioElement): void {
    if (this.current !== audio) {
      return; // a barge-in got here first — the clip is deliberately gone
    }
    this.queue.unshift(clip);
    this.playing = false;
    this.current = undefined;
    this.blocked = true;
    this.armUnlock();
    this.opts.onBlocked?.();
    this.opts.onIdle?.(); // nothing is audibly playing — clear the indicator
  }

  /** One-shot resume on the next user gesture (what unblocks autoplay). */
  private armUnlock(): void {
    if (this.unlockArmed || typeof document === "undefined") {
      return;
    }
    this.unlockArmed = true;
    const resume = (): void => {
      document.removeEventListener("pointerdown", resume, true);
      document.removeEventListener("keydown", resume, true);
      this.unlockArmed = false;
      // The gesture unblocks BOTH lanes: the clip queue resumes below, and a
      // suspended Web Audio context (streamed PCM) resumes here — its already
      // scheduled chunks then play from the resume point.
      void this.ctx?.resume?.();
      if (this.blocked) {
        this.blocked = false;
        if (!this.playing) {
          this.playNext();
        }
      }
    };
    document.addEventListener("pointerdown", resume, true);
    document.addEventListener("keydown", resume, true);
  }

  /** Barge-in: stop the current clip, drop the queue, silence any stream (talk-start). */
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
    if (this.streamId !== undefined) {
      this.cancelStream(this.streamId);
    }
    // A parked queue is dropped with the rest; the next clip retries playback
    // (and re-parks if the document still has no gesture).
    this.blocked = false;
    this.opts.onIdle?.();
  }

  /** True while a clip is playing/queued or a stream has scheduled audio. */
  get active(): boolean {
    return this.playing || this.streamOutstanding > 0;
  }

  dispose(): void {
    this.bargeIn();
  }
}
