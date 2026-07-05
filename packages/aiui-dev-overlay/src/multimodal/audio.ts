/**
 * Mic capture: one getUserMedia stream per session, one MediaRecorder run per
 * talk segment (talk-start → talk-end), yielding a webm/opus blob for the
 * transcriber. An AnalyserNode drives the HUD level meter so "is it hearing
 * me" is answered by pixels, not faith.
 *
 * Graduated from the workbench verbatim — pure browser-media plumbing, no
 * workbench or channel coupling. The overlay's `openai` transcriber uploads the
 * blob this produces to the channel; the workbench lab posts it to a dev proxy.
 */
export class AudioCapture {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private analyser: AnalyserNode | undefined;
  private levelData: Uint8Array<ArrayBuffer> | undefined;

  async ensureStream(): Promise<boolean> {
    if (this.stream) {
      return true;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.levelData = new Uint8Array(this.analyser.frequencyBinCount);
      source.connect(this.analyser);
      return true;
    } catch {
      return false; // no mic / denied — talking degrades to nothing, visibly
    }
  }

  /** 0..1 RMS-ish level for the meter; 0 when no stream. */
  level(): number {
    if (!this.analyser || !this.levelData) {
      return 0;
    }
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const value of this.levelData) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 3);
  }

  start(): boolean {
    if (!this.stream || this.recorder) {
      return false;
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: preferredMime() });
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    });
    this.recorder.start();
    return true;
  }

  async stop(): Promise<Blob | undefined> {
    const recorder = this.recorder;
    this.recorder = undefined;
    if (!recorder || recorder.state === "inactive") {
      return undefined;
    }
    const done = new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    recorder.stop();
    await done;
    return this.chunks.length ? new Blob(this.chunks, { type: recorder.mimeType }) : undefined;
  }

  dispose(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
  }
}

function preferredMime(): string {
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}
