import { createInkDocument, type InkCapture } from "@habemus-papadum/aiui-pencil/core";
import { action, control } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import { appScope } from "./store";
import {
  analyzeStructure,
  editStructure,
  hasReference,
  initialStructure,
  JOINT_IDS,
  type JointId,
  jointRef,
  memberRef,
  missingBrace,
  type Structure,
  type StructureEdit,
} from "./structure";

export const structureScope = appScope.child("structure");
export const structureHistory = structureScope.durableSignal<{
  current: Structure;
  past: Structure[];
  future: Structure[];
}>("history", { current: initialStructure(), past: [], future: [] });
export const structureSelection = structureScope.durableSignal<string>("selection", "joint/D");
export const focusedJoint = structureScope.durableSignal<JointId>("joint", "D");
export const structureNotice = structureScope.durableSignal("notice", "");
/** Color members by tension and compression, without changing the model. */
export const forceLens = control({ scope: structureScope, value: true });
/** Separate coincident member ends around the selected joint. Display only. */
export const explodedJoint = control({ scope: structureScope, value: false });
/** Show one normalized, infinitesimal unconstrained motion when a mechanism exists. */
export const showMotion = control({ scope: structureScope, value: true });
export const movePreview = structureScope.durableSignal<{
  joint: JointId;
  x: number;
  y: number;
  expectedRevision: number;
} | null>("move-preview", null);
export function structureInput() {
  const model = structureHistory.get().current;
  const preview = movePreview.get();
  if (!preview || preview.expectedRevision !== model.revision) return model;
  return {
    ...editStructure(model, { kind: "move", ...preview }, model.revision),
    revision: model.revision,
  };
}
/** Select a semantic reference. A joint changes the inspected free body; member selection keeps it. */
export const selectStructure = action({
  scope: structureScope,
  name: "select",
  params: { ref: "joint/A, member/m5, support/A, or load/main; inspect lists valid references" },
  run(args) {
    flush();
    const ref = args?.ref;
    if (typeof ref !== "string" || !hasReference(structureHistory.get().current, ref))
      throw new Error("Unknown structure reference.");
    flush(() => {
      structureSelection.set(ref);
      if (ref.startsWith("joint/") || ref.startsWith("support/"))
        focusedJoint.set(ref.split("/")[1] as JointId);
      if (ref === "load/main") focusedJoint.set(structureHistory.get().current.load.joint);
    });
    return { ref, joint: focusedJoint.get() };
  },
});
/** Apply one structural edit atomically, guarded by the revision obtained from inspect. */
export const changeStructure = action({
  scope: structureScope,
  name: "edit",
  params: {
    expectedRevision: "current model revision",
    edit: "{kind: add|remove|reconnect|move|support|load, ...}; inspect describes parameters",
  },
  run(args) {
    flush();
    const history = structureHistory.get();
    const next = editStructure(
      history.current,
      args?.edit as StructureEdit,
      args?.expectedRevision as number,
    );
    flush(() => {
      structureHistory.set({
        current: next,
        past: [...history.past, history.current].slice(-40),
        future: [],
      });
      movePreview.set(null);
      structureNotice.set("");
      if (!hasReference(next, structureSelection.get()))
        structureSelection.set(jointRef(focusedJoint.get()));
    });
    return { revision: next.revision, status: analyzeStructure(next).status };
  },
});
function restore(direction: "undo" | "redo") {
  flush();
  const h = structureHistory.get();
  const source = direction === "undo" ? h.past : h.future;
  if (!source.length) return { revision: h.current.revision };
  const next = {
    ...source[source.length - 1],
    revision: h.current.revision + 1,
    nextMember: Math.max(h.current.nextMember, source[source.length - 1].nextMember),
  };
  flush(() => {
    structureHistory.set(
      direction === "undo"
        ? { current: next, past: h.past.slice(0, -1), future: [...h.future, h.current] }
        : { current: next, past: [...h.past, h.current], future: h.future.slice(0, -1) },
    );
    movePreview.set(null);
    if (!hasReference(next, structureSelection.get()))
      structureSelection.set(jointRef(focusedJoint.get()));
    structureNotice.set("");
  });
  return { revision: next.revision };
}
/** Undo one edit or completed drag. Revision numbers always advance. */
export const undoStructure = action({
  scope: structureScope,
  name: "undo",
  run: () => restore("undo"),
});
/** Redo one undone edit, keeping surviving object IDs. */
export const redoStructure = action({
  scope: structureScope,
  name: "redo",
  run: () => restore("redo"),
});
export const structureInk = structureScope.durable("ink", () => createInkDocument());
interface BraceRequest {
  source: Structure;
  brace: { a: JointId; b: JointId };
  phase: "mark" | "preview" | "applied";
  capture?: InkCapture;
  image?: string;
}
export const braceRequest = structureScope.durableSignal<BraceRequest | null>("request", null);
/** Start a scripted pencil request against a frozen model. It proposes the first missing diagonal. */
export const beginBrace = action({
  scope: structureScope,
  name: "begin-brace",
  run() {
    flush();
    const source = structureHistory.get().current;
    const brace = missingBrace(source);
    if (!brace)
      throw new Error("Both diagonals already exist. Remove one before sketching a brace.");
    if (movePreview.get()) throw new Error("Finish moving the joint first.");
    structureInk.clear();
    flush(() => braceRequest.set({ source, brace, phase: "mark" }));
    return { revision: source.revision, ...brace, interpretation: "scripted, not recognized" };
  },
});
// The mounted Pencil view supplies only the bitmap renderer, never a domain mutation.
export const structurePorts = structureScope.durable<{ image?: (capture: InkCapture) => string }>(
  "ports",
  () => ({}),
);
/** Capture completed ink and preview the scripted addition without mutating the structure. */
export const previewBrace = action({
  scope: structureScope,
  name: "preview-brace",
  run() {
    flush();
    const request = braceRequest.get();
    if (request?.phase !== "mark") throw new Error("Start a pencil request first.");
    if (structureInk.snapshot().live.length) throw new Error("Lift the pen first.");
    const capture = structureInk.capture();
    if (!capture.strokes.length) throw new Error("Mark the proposed brace first.");
    if (!structurePorts.image) throw new Error("The pencil view is not mounted.");
    const image = structurePorts.image(capture);
    flush(() => braceRequest.set({ ...request, phase: "preview", capture, image }));
    return { expectedRevision: request.source.revision, edit: { kind: "add", ...request.brace } };
  },
});
/** Apply the captured topology proposal through the same revision-checked edit as manual input. */
export const applyBrace = action({
  scope: structureScope,
  name: "apply-brace",
  run() {
    flush();
    const request = braceRequest.get();
    if (request?.phase !== "preview") throw new Error("Preview a brace first.");
    const result = changeStructure.run({
      expectedRevision: request.source.revision,
      edit: { kind: "add", ...request.brace },
    });
    flush(() => braceRequest.set({ ...request, phase: "applied" }));
    return result;
  },
});
/** Dismiss the current request. The structure and its history are unchanged. */
export const closeBrace = action({
  scope: structureScope,
  name: "close-brace",
  run() {
    for (const live of structureInk.snapshot().live) structureInk.cancel(live.id);
    flush(() => braceRequest.set(null));
    return { closed: true };
  },
});
/** Restore the fixture as one undoable edit; clear the current pencil exercise. */
export const resetStructure = action({
  scope: structureScope,
  name: "reset",
  run() {
    flush();
    const h = structureHistory.get();
    // New fixture identities are reserved: reset intentionally returns to the named fixture.
    flush(() => {
      structureHistory.set({
        current: {
          ...initialStructure(h.current.revision + 1),
          nextMember: Math.max(6, h.current.nextMember),
        },
        past: [...h.past, h.current].slice(-40),
        future: [],
      });
      structureSelection.set("joint/D");
      focusedJoint.set("D");
      movePreview.set(null);
      braceRequest.set(null);
      structureNotice.set("");
    });
    return { revision: structureHistory.get().current.revision };
  },
});
/** Inspect source objects, targeted diagnostics and proposed topology without serializing raw ink. */
export const inspectStructure = action({
  scope: structureScope,
  name: "inspect",
  kind: "read",
  run() {
    flush();
    const source = structureHistory.get().current;
    const result = analyzeStructure(source);
    const request = braceRequest.get();
    return {
      ...result,
      selection: structureSelection.get(),
      focusedJoint: focusedJoint.get(),
      references: [
        ...JOINT_IDS.flatMap((id) => [jointRef(id), `support/${id}`]),
        ...source.members.map((m) => memberRef(m.id)),
        "load/main",
      ],
      proposal: request
        ? {
            phase: request.phase,
            expectedRevision: request.source.revision,
            stale: request.source.revision !== source.revision,
            edit: { kind: "add", ...request.brace },
            capturedStrokes: request.capture?.strokes.length ?? 0,
          }
        : null,
      edits: {
        add: "a,b",
        remove: "member",
        reconnect: "member,a,b",
        move: "joint,x,y (metres; 0.1 m grid, x 0..6, y 0..4)",
        support: "joint,support (none|pin|roller-y|roller-x)",
        load: "joint,magnitude (downward, 0..500 N)",
      },
      assumptions:
        "Ideal weightless axial members; bilateral supports; linearized rank test 1e-10; no stiffness, strength, buckling, deformation or finite-motion solution. Crossings are not joints.",
    };
  },
});
