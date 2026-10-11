import { createAudioHub } from "@habemus-papadum/aiui-audio";
import { createStt, type SttEvent, scribeTransport } from "../../src/index";

const hub = createAudioHub();
const input = hub.pcmInput({ id: "dictation", label: "Dictation" });
const events: Array<{ at: number; event: SttEvent }> = [];
const stt = createStt({
  audio: input,
  transport: scribeTransport({ connectUrl: () => window.mintScribeUrl(), language: "en" }),
});
stt.subscribe((event) => events.push({ at: performance.now(), event }));

const api = {
  hub,
  stt,
  events,
  async play(name: string, loop = false) {
    const response = await fetch(`/test/fixtures/${name}.wav`);
    if (!response.ok) throw new Error(`Missing speech fixture: ${name}`);
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      const samples = new Float32Array(decoded.getChannelData(0));
      await hub.selectInput(input.id);
      const startedAt = performance.now();
      await hub.startRecording(samples, decoded.sampleRate, { loop });
      return { startedAt, durationMs: decoded.duration * 1000 };
    } finally {
      await context.close();
    }
  },
  async finish() {
    await stt.endSegment();
    return stt.drain(15_000);
  },
  async dispose() {
    stt.close();
    await hub.dispose();
  },
};

declare global {
  interface Window {
    mintScribeUrl(): Promise<string>;
    sttTest: typeof api;
  }
}
window.sttTest = api;
