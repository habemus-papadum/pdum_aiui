import { PencilSurface } from "@habemus-papadum/aiui-pencil/canvas";
import { WRITE } from "@habemus-papadum/aiui-pencil/core";
import { bridgeEffect, elementWidth } from "@habemus-papadum/aiui-viz";
import { createSignal, onCleanup } from "solid-js";
import { attachInk, type Evidence, type FrozenView } from "../model/markup";
import { inkDocument, markupPorts } from "../model/markup-store";
import { appScope } from "../model/store";
import { inkImage } from "./markup-images";

export function MarkupPad(props: { sheet: FrozenView; active: boolean }) {
  const [host, setHost] = createSignal<HTMLDivElement>();
  const width = elementWidth(host);
  let paper: PencilSurface | undefined;
  let scale = 0;
  let enabled: boolean | undefined;
  let frame = 0;
  const renderEvidence = (): Evidence => {
    const ink = inkDocument.capture();
    const attachment = attachInk(ink, props.sheet);
    return Object.freeze({
      view: props.sheet,
      ink,
      inkImage: inkImage(ink, props.sheet.size),
      attachment,
      attachmentImage: attachment.attached
        ? inkImage(attachment.capture, attachment.bounds, {
            x: -attachment.bounds.x,
            y: -attachment.bounds.y,
            scale: 1,
          })
        : "",
    });
  };
  bridgeEffect(
    () => ({
      target: host(),
      width: width(),
      active: props.active,
      sheetWidth: props.sheet.size.width,
    }),
    ({ target, width: currentWidth, active, sheetWidth }) => {
      if (!target || currentWidth <= 0) return;
      if (!paper) {
        paper = new PencilSurface({
          target,
          document: inkDocument,
          className: "svg-lab-markup-canvas",
          navigation: false,
          params: () => ({ ...WRITE, size: 2.5, color: "#f2c66d", grain: 0.15, flow: 0.85 }),
          inputOptions: { fingerDrawing: "until-pen" },
        });
        paper.canvas.setAttribute("aria-label", "Draw your markup here");
        paper.setActive(true);
        markupPorts.renderEvidence = renderEvidence;
      }
      const nextScale = currentWidth / sheetWidth;
      if (nextScale !== scale) {
        paper.setViewport({ x: 0, y: 0, scale: nextScale });
        scale = nextScale;
      }
      if (enabled !== active) {
        paper.input?.setEnabled(active);
        paper.canvas.style.pointerEvents = active ? "auto" : "none";
        enabled = active;
      }
    },
    { scope: appScope, name: "markup-pad" },
  );
  onCleanup(() => {
    cancelAnimationFrame(frame);
    if (markupPorts.renderEvidence === renderEvidence) delete markupPorts.renderEvidence;
    paper?.dispose();
  });
  return (
    <div
      class="svg-lab-markup-pad"
      data-writing={props.active ? "true" : "false"}
      style={{ "aspect-ratio": `${props.sheet.size.width} / ${props.sheet.size.height}` }}
      ref={(element) => {
        frame = requestAnimationFrame(() => {
          elementWidth(element)();
          setHost(element);
        });
      }}
    >
      <img
        src={props.sheet.image}
        alt="Frozen circuit view used for this markup"
        draggable={false}
      />
    </div>
  );
}
