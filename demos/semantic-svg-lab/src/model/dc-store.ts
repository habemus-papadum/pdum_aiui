import { createInkDocument, type InkCapture } from "@habemus-papadum/aiui-pencil/core";
import { action, control } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import {
  analyzeDC,
  type DCCircuit,
  type DCEdit,
  editDC,
  initialDC,
  missingReturn,
  PARTS,
  type PartId,
  PINS,
  type PinId,
  pinRef,
  validDCRef,
  wireRef,
} from "./dc-circuit";
import { type DCLayout, initialDCLayout, moveDCPart } from "./dc-layout";
import { appScope } from "./store";
export const dcScope = appScope.child("dc");
export const dcHistory = dcScope.durableSignal<{
  current: DCCircuit;
  past: DCCircuit[];
  future: DCCircuit[];
}>("history", { current: initialDC(), past: [], future: [] });
export const dcLayout = dcScope.durableSignal<DCLayout>("layout", initialDCLayout());
export const dcSelection = dcScope.durableSignal("selection", "pin/R2/a");
export const dcAnchor = dcScope.durableSignal<PinId>("anchor", "R2/a");
export const dcNotice = dcScope.durableSignal("notice", "");
/** Color wires and terminals by their solved voltage. This changes no circuit facts. */
export const voltageLens = control({ scope: dcScope, value: true });
/** Reveal stable terminal names in the schematic. */
export const terminalNames = control({ scope: dcScope, value: true });
export const dcInput = () => dcHistory.get().current;
function install(next: DCCircuit) {
  const h = dcHistory.get();
  flush(() => {
    dcHistory.set({ current: next, past: [...h.past, h.current].slice(-40), future: [] });
    if (!validDCRef(next, dcSelection.get())) dcSelection.set(pinRef(dcAnchor.get()));
    dcNotice.set("");
  });
}
/** Apply one revision-guarded wiring or parameter edit. UI and agent tools use this same boundary. */
export const changeDC = action({
  scope: dcScope,
  name: "edit",
  params: {
    expectedRevision: "current revision from dc/inspect",
    edit: "connect {a,b}; disconnect {wire}; reconnect {wire,a,b}; resistance {part,ohms}; supply {volts}; detach-load",
  },
  run(args) {
    flush();
    const next = editDC(dcInput(), args?.edit as DCEdit, args?.expectedRevision as number);
    install(next);
    return { revision: next.revision, status: analyzeDC(next).status };
  },
});
/** Select an object and reveal its electrical net, anchored to a stable terminal rather than a transient net ID. */
export const selectDC = action({
  scope: dcScope,
  name: "select",
  params: { ref: "pin/R2/a, part/R1, wire/w3; dc/inspect lists all valid keys" },
  run(args) {
    flush();
    const ref = args?.ref,
      model = dcInput();
    if (typeof ref !== "string" || !validDCRef(model, ref))
      throw new Error("Unknown circuit reference.");
    const result = analyzeDC(model);
    let anchor = dcAnchor.get();
    if (ref.startsWith("pin/")) anchor = ref.slice(4) as PinId;
    else if (ref.startsWith("wire/")) {
      const wire = model.wires.find((w) => wireRef(w.id) === ref);
      if (wire) anchor = wire.a;
    } else if (ref.startsWith("part/")) {
      const part = ref.slice(5) as PartId;
      const pins = PINS.filter((p) => p.startsWith(`${part}/`));
      anchor = pins.find((p) => result.netOf[p] === result.netOf[anchor]) ?? pins[0];
    }
    flush(() => {
      dcSelection.set(ref);
      dcAnchor.set(anchor);
    });
    return { ref, anchor };
  },
});
/** Move a symbol in drawing coordinates. This never changes wiring, electrical revision or analysis. */
export const moveDCSymbol = action({
  scope: dcScope,
  name: "place",
  params: {
    part: "V1, R1, R2 or RL",
    x: "drawing x (80..600, 10-unit grid)",
    y: "drawing y (100..330, 10-unit grid)",
  },
  run(args) {
    flush();
    const next = moveDCPart(
      dcLayout.get(),
      args?.part as PartId,
      args?.x as number,
      args?.y as number,
    );
    flush(() => dcLayout.set(next));
    return next;
  },
});
/** Restore symbol positions without changing the circuit. */
export const resetDCLayout = action({
  scope: dcScope,
  name: "reset-layout",
  run() {
    flush(() => dcLayout.set(initialDCLayout()));
    return { restored: true };
  },
});
function restore(direction: "undo" | "redo") {
  flush();
  const h = dcHistory.get(),
    from = direction === "undo" ? h.past : h.future;
  if (!from.length) return { revision: h.current.revision };
  const last = from[from.length - 1],
    next = {
      ...last,
      revision: h.current.revision + 1,
      nextWire: Math.max(last.nextWire, h.current.nextWire),
    };
  flush(() => {
    dcHistory.set(
      direction === "undo"
        ? { current: next, past: h.past.slice(0, -1), future: [...h.future, h.current] }
        : { current: next, past: [...h.past, h.current], future: h.future.slice(0, -1) },
    );
    if (!validDCRef(next, dcSelection.get())) dcSelection.set(pinRef(dcAnchor.get()));
    dcNotice.set("");
  });
  return { revision: next.revision };
}
/** Undo one circuit edit; drawing positions stay where they are. */
export const undoDC = action({ scope: dcScope, name: "undo", run: () => restore("undo") });
/** Redo one circuit edit with a fresh revision. */
export const redoDC = action({ scope: dcScope, name: "redo", run: () => restore("redo") });
export const DC_CASES = ["working", "open-return", "floating-load", "source-short"] as const;
/** Replace the electrical circuit with a named case as one undoable edit. Layout is preserved. */
export const loadDCCase = action({
  scope: dcScope,
  name: "load-case",
  params: { case: "working | open-return | floating-load | source-short" },
  run(args) {
    flush();
    const kind = args?.case;
    if (!DC_CASES.includes(kind as (typeof DC_CASES)[number]))
      throw new Error("Unknown circuit case.");
    const current = dcInput();
    let next = { ...initialDC(current.revision), nextWire: Math.max(6, current.nextWire) };
    if (kind === "open-return")
      next = editDC(next, { kind: "disconnect", wire: "w3" }, next.revision);
    if (kind === "floating-load") next = editDC(next, { kind: "detach-load" }, next.revision);
    if (kind === "source-short")
      next = editDC(next, { kind: "connect", a: "V1/p", b: "V1/n" }, next.revision);
    next = { ...next, revision: current.revision + 1 };
    install(next);
    flush(() => {
      dcSelection.set("pin/R2/a");
      dcAnchor.set("R2/a");
    });
    return { revision: next.revision };
  },
});
interface ReturnRequest {
  source: DCCircuit;
  layout: DCLayout;
  phase: "mark" | "preview" | "applied";
  capture?: InkCapture;
  image?: string;
}
export const returnRequest = dcScope.durableSignal<ReturnRequest | null>("request", null);
export const dcInk = dcScope.durable("ink", () => createInkDocument());
export const dcPorts = dcScope.durable<{ image?: (capture: InkCapture) => string }>(
  "ports",
  () => ({}),
);
/** Freeze the circuit and drawing layout for an explicitly scripted R2/b → V1/n connection. */
export const beginDCReturn = action({
  scope: dcScope,
  name: "begin-return",
  run() {
    flush();
    const source = dcInput();
    if (!missingReturn(analyzeDC(source)))
      throw new Error("R2/b already belongs to the return net. Open the return first.");
    dcInk.clear();
    flush(() => returnRequest.set({ source, layout: dcLayout.get(), phase: "mark" }));
    return {
      expectedRevision: source.revision,
      edit: { kind: "connect", a: "R2/b", b: "V1/n" },
      interpretation: "scripted",
    };
  },
});
/** Capture actual Pencil input and preview the known connection; no handwriting recognition runs. */
export const previewDCReturn = action({
  scope: dcScope,
  name: "preview-return",
  run() {
    flush();
    const request = returnRequest.get();
    if (request?.phase !== "mark") throw new Error("Start a pencil request first.");
    if (dcInk.snapshot().live.length) throw new Error("Lift the pen first.");
    const capture = dcInk.capture();
    if (!capture.strokes.length) throw new Error("Draw the proposed return connection first.");
    if (!dcPorts.image) throw new Error("The pencil surface is not mounted.");
    const image = dcPorts.image(capture);
    flush(() => returnRequest.set({ ...request, capture, image, phase: "preview" }));
    return { expectedRevision: request.source.revision };
  },
});
/** Apply the exact proposed connection through the shared circuit edit operation. */
export const applyDCReturn = action({
  scope: dcScope,
  name: "apply-return",
  run() {
    flush();
    const request = returnRequest.get();
    if (request?.phase !== "preview") throw new Error("Preview the connection first.");
    const result = changeDC.run({
      expectedRevision: request.source.revision,
      edit: { kind: "connect", a: "R2/b", b: "V1/n" },
    });
    flush(() => returnRequest.set({ ...request, phase: "applied" }));
    return result;
  },
});
/** Close the request without altering the circuit or its edit history. */
export const closeDCReturn = action({
  scope: dcScope,
  name: "close-return",
  run() {
    for (const stroke of dcInk.snapshot().live) dcInk.cancel(stroke.id);
    flush(() => returnRequest.set(null));
    return { closed: true };
  },
});
/** Read committed circuit facts, derived net membership, stable references and compact proposal state. */
export const inspectDC = action({
  scope: dcScope,
  name: "inspect",
  kind: "read",
  run() {
    flush();
    const result = analyzeDC(dcInput()),
      request = returnRequest.get();
    return {
      ...result,
      selection: dcSelection.get(),
      anchor: dcAnchor.get(),
      layout: dcLayout.get(),
      references: [
        ...PINS.map(pinRef),
        ...PARTS.map((part) => `part/${part}`),
        ...dcInput().wires.map((w) => wireRef(w.id)),
      ],
      proposal: request
        ? {
            phase: request.phase,
            expectedRevision: request.source.revision,
            stale: request.phase !== "applied" && request.source.revision !== dcInput().revision,
            capturedStrokes: request.capture?.strokes.length ?? 0,
            edit: { kind: "connect", a: "R2/b", b: "V1/n" },
          }
        : null,
      assumptions:
        "One ideal source referenced at V1/n; three positive resistors; explicit ideal-wire connectivity. Linear DC, no AC/transients, parasitics, tolerances or per-wire current allocation. Floating absolute voltages withheld; passive island currents are zero; referenced islands remain solved.",
    };
  },
});
