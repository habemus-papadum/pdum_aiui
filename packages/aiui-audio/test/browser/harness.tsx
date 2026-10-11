import { render } from "@solidjs/web";
import { createAudioHub } from "../../src/index";
import { AudioControl } from "../../src/widgets";

const hub = createAudioHub();
const counts = { a: 0, b: 0 };
const a = hub.pcmInput({ id: "a", label: "Dictation", icon: "✍" });
const b = hub.pcmInput({ id: "b", label: "Editor", icon: "🔮" });
const stream = hub.streamInput({ id: "stream", label: "Live" });
let restore: ReturnType<typeof hub.temporarilyRouteInput> | undefined;
let observer: AudioContext;
let analyser: AnalyserNode;
const api = {
  hub,
  counts,
  async start() {
    await a.start((bytes) => {
      if (bytes.some((x) => x)) counts.a += bytes.length;
    });
    await b.start((bytes) => {
      if (bytes.some((x) => x)) counts.b += bytes.length;
    });
    stream.setEnabled(true);
    observer = new AudioContext();
    analyser = observer.createAnalyser();
    observer.createMediaStreamSource(stream.stream()).connect(analyser);
    await observer.resume();
    await hub.selectInput("a");
    const samples = Float32Array.from(
      { length: 24000 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 24000),
    );
    await hub.startRecording(samples, 24000, { loop: true });
  },
  temporary() {
    restore = hub.temporarilyRouteInput("b");
  },
  restore: () => restore?.release(),
  streamLevel() {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return Math.max(...data.map(Math.abs));
  },
  trackState: () => stream.stream().getAudioTracks()[0].readyState,
  async stop() {
    await hub.dispose();
    await observer?.close();
  },
};
Object.assign(window, { audioTest: api });
render(() => <AudioControl hub={hub} />, document.getElementById("app") as HTMLElement);
