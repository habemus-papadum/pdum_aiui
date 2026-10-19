import { TOKENS } from "@habemus-papadum/aiui-design";
import { CanvasInkView } from "@habemus-papadum/aiui-pencil/canvas";
import { createInkDocument, type InkCapture } from "@habemus-papadum/aiui-pencil/core";
import type { FrozenView } from "../model/markup";
import type { Camera, ViewSize } from "../model/projection";

/** Freeze the SVG's visible styling, not references to live classes or external stylesheets. */
export function snapshotSvg(svg: SVGSVGElement, context: Omit<FrozenView, "image">): FrozenView {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll("*")];
  const clones = [copy, ...copy.querySelectorAll("*")];
  const properties = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
    "font-size",
    "font-weight",
    "letter-spacing",
    "text-anchor",
    "opacity",
  ];
  for (let i = 0; i < originals.length; i++) {
    const source = getComputedStyle(originals[i]);
    for (const property of properties)
      (clones[i] as SVGElement).style.setProperty(property, source.getPropertyValue(property));
    // The writing sheet uses a self-contained font stack; its captured image never depends on font loading later.
    (clones[i] as SVGElement).style.setProperty("font-family", "Georgia, serif");
  }
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(context.size.width));
  copy.setAttribute("height", String(context.size.height));
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", TOKENS.plate);
  copy.prepend(background);
  return {
    ...context,
    image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`,
  };
}
/** Independent render: the working canvas's scale, cache and subsequent edits cannot change this image. */
export function inkImage(
  capture: InkCapture,
  size: ViewSize,
  viewport: Camera = { x: 0, y: 0, scale: 1 },
): string {
  const view = new CanvasInkView({ document: createInkDocument(), viewport });
  try {
    view.setActive(false);
    // Bound raster memory while retaining the original editable records in the evidence.
    const density = Math.min(2, 2000 / Math.max(size.width, size.height));
    return view
      .renderCapture(capture, Math.max(1, size.width), Math.max(1, size.height), density)
      .toDataURL("image/png");
  } finally {
    view.dispose();
  }
}
