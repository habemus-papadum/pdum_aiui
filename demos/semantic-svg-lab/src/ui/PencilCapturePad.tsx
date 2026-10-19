import { PencilSurface } from "@habemus-papadum/aiui-pencil/canvas";
import { type InkCapture, type InkDocument, WRITE } from "@habemus-papadum/aiui-pencil/core";
import { bridgeEffect, elementWidth, type Scope } from "@habemus-papadum/aiui-viz";
import { createSignal, onCleanup } from "solid-js";
import { inkImage } from "./markup-images";
/** Application-local capture adapter shared by the two editing studies. No domain/model knowledge. */
export function PencilCapturePad(props: {
  document: InkDocument;
  scope: Scope;
  size: { width: number; height: number };
  ports: { image?: (capture: InkCapture) => string };
  label: string;
  color: string;
  class?: string;
}) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  const width = elementWidth(host);
  let paper: PencilSurface | undefined,
    frame = 0,
    scale = 0;
  const render = (capture: InkCapture) => inkImage(capture, props.size);
  bridgeEffect(
    () => ({ target: host(), width: width() }),
    ({ target, width }) => {
      if (!target || width <= 0) return;
      if (!paper) {
        paper = new PencilSurface({
          target,
          document: props.document,
          navigation: false,
          params: () => ({ ...WRITE, color: props.color, size: 3, grain: 0.1 }),
          inputOptions: { fingerDrawing: "until-pen" },
        });
        paper.canvas.setAttribute("aria-label", props.label);
        paper.setActive(true);
        props.ports.image = render;
      }
      const next = width / props.size.width;
      if (next !== scale) {
        paper.setViewport({ x: 0, y: 0, scale: next });
        scale = next;
      }
    },
    { scope: props.scope, name: "capture-pencil" },
  );
  onCleanup(() => {
    cancelAnimationFrame(frame);
    if (props.ports.image === render) delete props.ports.image;
    paper?.dispose();
  });
  return (
    <div
      class={`svg-pencil-capture ${props.class ?? ""}`}
      ref={(element) => {
        frame = requestAnimationFrame(() => {
          elementWidth(element)();
          setHost(element);
        });
      }}
    />
  );
}
