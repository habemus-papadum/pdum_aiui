import { WRITE } from "@habemus-papadum/aiui-pencil/core";
import { flush } from "solid-js";
import { beforeEach, expect, it } from "vitest";
import { initialCircuit } from "./circuit";
import { attachInk, type Evidence, freezeView } from "./markup";
import {
  applyMarkup,
  beginMarkup,
  cancelMarkup,
  captureMarkup,
  inkDocument,
  interruptMarkup,
  markupPorts,
  reconsiderMarkup,
  restartMarkup,
  reviewMarkup,
  undoMarkup,
  workflow,
} from "./markup-store";
import { history, selected, setResistance } from "./store";

function addStroke(id: string) {
  const p = {
    x: 150,
    y: 150,
    t: 0,
    pressure: 0.5,
    altitude: Math.PI / 2,
    azimuth: 0,
    twist: 0,
    kind: "pen" as const,
    width: 1,
    height: 1,
  };
  inkDocument.begin(id, { tool: "draw", params: WRITE, point: p });
  inkDocument.finish(id, { ...p, x: 180, t: 20 });
  flush();
}
let serial = 0;
beforeEach(() => {
  restartMarkup.run();
  flush(() => {
    history.set({ current: initialCircuit(), past: [], future: [] });
    selected.set("a/R1/value");
  });
  markupPorts.readView = () =>
    freezeView({
      image: "frozen-svg",
      size: { width: 800, height: 520 },
      camera: { x: 0, y: 0, scale: 1 },
      lens: null,
      target: "a/R1/value",
      circuit: history.get().current,
    });
  markupPorts.renderEvidence = (): Evidence => {
    const view = workflow.get().sheet;
    if (!view) throw new Error("Missing view");
    const ink = inkDocument.capture();
    return {
      view,
      ink,
      inkImage: "frozen-ink",
      attachment: attachInk(ink, view),
      attachmentImage: "attached-ink",
    };
  };
});
async function toReview() {
  beginMarkup.run();
  await addStroke(`request-${serial++}`);
  captureMarkup.run();
  await addStroke(`later-${serial++}`);
  reviewMarkup.run();
}

it("enforces the guided steps and retains newer ink when applying and undoing", async () => {
  expect(() => captureMarkup.run()).toThrow();
  beginMarkup.run();
  expect(() => captureMarkup.run()).toThrow();
  await addStroke(`request-${serial++}`);
  captureMarkup.run();
  expect(() => reviewMarkup.run()).toThrow();
  const evidence = workflow.get().evidence;
  const later = `later-${serial++}`;
  await addStroke(later);
  reviewMarkup.run();
  applyMarkup.run();
  expect(history.get().current.stages.a.resistance).toBe(6800);
  expect(history.get().past).toHaveLength(1);
  expect(inkDocument.snapshot().strokes.map((item) => item.id)).toEqual([later]);
  expect(workflow.get().evidence).toBe(evidence);
  expect(() => applyMarkup.run()).toThrow();
  undoMarkup.run();
  expect(history.get().current.stages.a.resistance).toBe(4700);
  expect(inkDocument.snapshot().strokes.map((item) => item.id)).toEqual([later]);
});
it("refuses a stale proposal without retiring ink, then permits explicit reconsideration", async () => {
  await toReview();
  const evidence = workflow.get().evidence;
  interruptMarkup.run();
  expect(applyMarkup.run()).toEqual({ applied: false, reason: "stale" });
  expect(history.get().current.stages.a.resistance).toBe(8200);
  expect(inkDocument.snapshot().strokes).toHaveLength(2);
  reconsiderMarkup.run();
  applyMarkup.run();
  expect(history.get().current.stages.a.resistance).toBe(6800);
  expect(workflow.get().evidence).toBe(evidence);
  undoMarkup.run();
  expect(history.get().current.stages.a.resistance).toBe(8200);
});
it("declining keeps ink; undo cannot accidentally undo a subsequent writer's edit", async () => {
  await toReview();
  cancelMarkup.run();
  expect(history.get().current.revision).toBe(0);
  expect(inkDocument.snapshot().strokes).toHaveLength(2);
  restartMarkup.run();
  await toReview();
  applyMarkup.run();
  setResistance.run({
    key: "b/R1/value",
    ohms: 2200,
    expectedRevision: history.get().current.revision,
  });
  expect(() => undoMarkup.run()).toThrow();
  expect(history.get().current.stages.b.resistance).toBe(2200);
});
