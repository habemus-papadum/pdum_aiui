import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { createScreenCapture, type ScreenCapture, type ScreenCaptureDriver } from "../../src";
import { ScreenCaptureControl, ScreenCapturePreview, ScreenCaptureTarget } from "../../src/widgets";

declare global {
  interface Window {
    capture: ScreenCapture;
    borrowed?: MediaStream;
    pixel(): number[];
    togglePreview(): void;
    disposeHarness(): void;
  }
}
const synthetic = new URLSearchParams(location.search).has("synthetic");
const driver: ScreenCaptureDriver | undefined = synthetic
  ? {
      capabilities: () => ({ screen: true, region: false, element: false }),
      async acquire() {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d");
        const stream = canvas.captureStream(20);
        let count = 0;
        const timer = setInterval(() => {
          if (!context) return;
          context.fillStyle = count++ % 2 ? "red" : "blue";
          context.fillRect(0, 0, 320, 180);
        }, 50);
        const track = stream.getVideoTracks()[0];
        if (track) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            clearInterval(timer);
            stop();
          };
        }
        return stream;
      },
      async applyTarget() {
        throw new Error("Synthetic input has no native cropping");
      },
    }
  : undefined;
const capture = createScreenCapture({ driver });
window.capture = capture;
capture.subscribe(() => {
  if (capture.stream()) window.borrowed = capture.stream();
});
function App() {
  let first!: HTMLDivElement;
  let second!: HTMLDivElement;
  const [preview, setPreview] = createSignal(true, { ownedWrite: true });
  window.togglePreview = () => setPreview((value) => !value);
  return (
    <>
      <ScreenCaptureControl
        capture={capture}
        targets={[
          { label: "Red chart", element: () => first },
          { label: "Green chart", element: () => second },
        ]}
      />
      <div style={{ position: "relative", margin: "20px", width: "300px" }}>
        <ScreenCaptureTarget
          ref={(element) => {
            first = element;
            first.id = "first";
          }}
          label="Red chart"
          style={{ width: "300px", height: "180px", background: "rgb(255, 0, 0)" }}
        >
          <span class="motion" />
        </ScreenCaptureTarget>
        <div
          id="occluder"
          style={{
            position: "absolute",
            left: "40px",
            top: "30px",
            width: "120px",
            height: "80px",
            background: "rgb(0, 0, 255)",
          }}
        />
      </div>
      <ScreenCaptureTarget
        ref={(element) => {
          second = element;
          second.id = "second";
        }}
        label="Green chart"
        style={{ width: "200px", height: "100px", background: "rgb(0, 255, 0)", margin: "20px" }}
      >
        <span class="motion" />
      </ScreenCaptureTarget>
      <style>
        {
          ".aiui-capture-preview { max-width:360px; } .motion { display:block; width:4px;height:4px;background:white;animation:move 1s linear infinite; } @keyframes move { to { transform:translateX(100px); } }"
        }
      </style>
      <Show when={preview()}>
        <ScreenCapturePreview capture={capture} />
      </Show>
    </>
  );
}
const dispose = render(
  () => (
    <PageBoundary name="capture test">
      <App />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
window.disposeHarness = () => {
  dispose();
  capture.dispose();
};
window.pixel = () => {
  const video = document.querySelector("video");
  if (!video?.videoWidth) return [];
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) return [];
  context.drawImage(video, 0, 0);
  return [
    ...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
  ];
};
