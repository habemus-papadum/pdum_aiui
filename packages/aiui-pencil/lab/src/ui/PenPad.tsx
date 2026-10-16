/** Mount the editable ink view and its diagnostic overlay. */
import { bridgeEffect } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, untrack } from "solid-js";
import {
  contentWidth,
  currentParams,
  fadeSec,
  fillDabs,
  linkContent,
  pad,
  paper,
  pencilMode,
  scene,
  sceneMappingValid,
  showCusps,
  showDabs,
  showFiltered,
  showRaw,
} from "../model/store";
import { SceneContent } from "./SceneContent";

export function PenPad(): JSX.Element {
  const [host, setHost] = createSignal<HTMLDivElement | undefined>(undefined);
  // Ref callbacks run before nested components are inserted. An effect waits
  // for that DOM commit, and its returned cleanup belongs to this component.
  createEffect(host, (element) => {
    if (!element) return;
    scene.mount(element);
    return () => scene.unmount(element);
  });
  bridgeEffect(
    () => ({
      raw: showRaw.get(),
      filtered: showFiltered.get(),
      cusps: showCusps.get(),
      dabs: showDabs.get(),
      fill: fillDabs.get(),
    }),
    (view) => pad.setView(view),
  );
  bridgeEffect(currentParams, (params) => {
    const ids = paper.document.snapshot().strokes.map((stroke) => stroke.id);
    paper.document.setParams(ids, params);
  });
  bridgeEffect(
    () => fadeSec.get(),
    () => untrack(() => paper.refresh()),
  );
  pad.setDocument(paper.document, () => paper.view.getViewport());
  bridgeEffect(
    () => pencilMode.get(),
    (enabled) => paper.input?.setPenEnabled(enabled),
  );
  bridgeEffect(
    () => linkContent.get(),
    (linked) => scene.linkedChanged(linked),
  );
  bridgeEffect(
    () => contentWidth.get(),
    (width) => scene.reflow(width),
  );

  return (
    <div class="pad" ref={(element) => setHost(element)}>
      <SceneContent />
      <div class="scene-status" data-scene-status>
        {sceneMappingValid.get()
          ? "Pen or mouse: draw · two fingers: navigate · wheel: scroll"
          : "Ink paused after reflow — resume from Scene navigation"}
      </div>
    </div>
  );
}
