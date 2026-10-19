import { action, control, scope } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import {
  commit,
  describeCircuit,
  editResistance,
  type History,
  initialCircuit,
  type Point,
  parseCircuit,
  resolveFeature,
  travel,
} from "./circuit";

export const appScope = scope("semantic-svg-lab");
const SAVE_KEY = "aiui:semantic-svg-lab:circuit:1";
function load(): History {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    return {
      current: saved ? parseCircuit(JSON.parse(saved)) : initialCircuit(),
      past: [],
      future: [],
    };
  } catch {
    return { current: initialCircuit(), past: [], future: [] };
  }
}
export const history = appScope.durableSignal<History>("circuit", load());
export const selected = appScope.durableSignal("selected", "a/R1/value");
export const selectedIn = appScope.durableSignal("selected-in", "main");
export const pan = appScope.durableSignal<Point>("pan", { x: 0, y: 0 });
export const lensPosition = appScope.durableSignal<Point>("lens-position", { x: 0.25, y: 0.5 });
export const notice = appScope.durableSignal("notice", "");
/** Magnification of the main drawing. Navigation never changes the circuit. */
export const zoom = control({ scope: appScope, value: 1, min: 0.6, max: 3, step: 0.1 });
/** Additional magnification inside the terminal-revealing lens. */
export const magnification = control({ scope: appScope, value: 1.3, min: 1, max: 2.5, step: 0.1 });
/** Show the movable terminal lens over the circuit. */
export const lensVisible = control({ scope: appScope, value: true });

function update(change: (previous: History) => History) {
  let result = history.get();
  flush(() => {
    result = history.set(change);
  });
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(result.current));
    notice.set("");
  } catch {
    notice.set("Browser storage is unavailable. This circuit will last for this session only.");
  }
  return result.current;
}
/** Select one fully qualified circuit feature from any representation.
 * @usage Use inspect-circuit to discover keys. Selecting a hidden pin retains its identity in every view.
 * @example {"key":"a/M1/bulk","view":"lens"}
 */
export const selectFeature = action({
  scope: appScope,
  name: "select-feature",
  params: {
    key: "Occurrence/part/feature, e.g. a/R1/value",
    view: "main, lens, overview, or agent",
  },
  run(args) {
    const feature = resolveFeature(String(args?.key));
    const view = String(args?.view ?? "agent");
    if (!["main", "lens", "overview", "agent"].includes(view)) throw new Error("Unknown view.");
    flush(() => {
      selected.set(feature.key);
      selectedIn.set(view);
    });
    return feature;
  },
});
/** Change one resistor value through the same validated operation as the lens editor.
 * @usage Read the revision with inspect-circuit first. This creates one undo step; stale writes are refused.
 * @example {"key":"a/R1/value","ohms":6800,"expectedRevision":0}
 */
export const setResistance = action({
  scope: appScope,
  name: "set-resistance",
  inputSchema: {
    type: "object",
    required: ["key", "ohms", "expectedRevision"],
    additionalProperties: false,
    properties: {
      key: { type: "string", enum: ["a/R1/value", "b/R1/value"] },
      ohms: { type: "number", minimum: 100, maximum: 100000, multipleOf: 100 },
      expectedRevision: { type: "integer", minimum: 0 },
    },
  },
  run(args) {
    if (typeof args?.ohms !== "number" || typeof args.expectedRevision !== "number")
      throw new Error("ohms and expectedRevision must be numbers.");
    const ohms = args.ohms;
    const expectedRevision = args.expectedRevision;
    return update((previous) =>
      commit(previous, editResistance(previous.current, String(args.key), ohms, expectedRevision)),
    );
  },
});
/** Restore the previous circuit values, with a fresh revision. */
export const undo = action({
  scope: appScope,
  name: "undo",
  run: () => update((previous) => travel(previous, "undo")),
});
/** Reapply an undone circuit edit, with a fresh revision. */
export const redo = action({
  scope: appScope,
  name: "redo",
  run: () => update((previous) => travel(previous, "redo")),
});
/** Restore the fixture values as one undoable edit. */
export const resetCircuit = action({
  scope: appScope,
  name: "reset-circuit",
  run: () =>
    update((previous) =>
      commit(previous, { ...initialCircuit(), revision: previous.current.revision + 1 }),
    ),
});
/** Restore the initial camera and lens position, preserving the circuit and its history. */
export const resetView = action({
  scope: appScope,
  name: "reset-view",
  run() {
    flush(() => {
      pan.set({ x: 0, y: 0 });
      lensPosition.set({ x: 0.25, y: 0.5 });
      zoom.set(1);
      magnification.set(1.3);
      lensVisible.set(true);
    });
    return { pan: { x: 0, y: 0 }, zoom: 1 };
  },
});
/** Move the camera in world units, or the lens in normalized viewport coordinates.
 * @example {"target":"lens","x":0.7,"y":0.5}
 */
export const navigate = action({
  scope: appScope,
  name: "navigate",
  params: {
    target: "camera or lens",
    x: "Horizontal offset (camera), or fraction 0–1 (lens)",
    y: "Vertical offset (camera), or fraction 0–1 (lens)",
  },
  run(args) {
    const x = args?.x;
    const y = args?.y;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      throw new Error("Navigation needs finite x and y.");
    if (args?.target === "lens") {
      if (x < 0 || x > 1 || y < 0 || y > 1)
        throw new Error("Lens coordinates must be between 0 and 1.");
      flush(() => lensPosition.set({ x, y }));
    } else if (args?.target === "camera") {
      flush(() => pan.set({ x, y }));
    } else throw new Error("Choose camera or lens.");
    return { x, y };
  },
});
/** Read the circuit, feature identities, semantic selection and navigation state.
 * @usage SVG appearances share these keys. Hidden pins remain in this snapshot. No electrical simulation is performed.
 */
export const inspectCircuit = action({
  scope: appScope,
  name: "inspect-circuit",
  kind: "read",
  run() {
    flush();
    return {
      ...describeCircuit(history.get().current),
      selection: { ...resolveFeature(selected.get()), view: selectedIn.get() },
      camera: { pan: pan.get(), zoom: zoom.get() },
      lens: {
        position: lensPosition.get(),
        magnification: magnification.get(),
        visible: lensVisible.get(),
      },
      undoSteps: history.get().past.length,
      redoSteps: history.get().future.length,
    };
  },
});
