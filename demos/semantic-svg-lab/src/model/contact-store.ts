import { action, control } from "@habemus-papadum/aiui-viz";
import { flush } from "solid-js";
import {
  CONTACT_FEATURES,
  CONTACT_LIMITS,
  type ContactFeature,
  type ContactPoint,
  circleLineContact,
  movePosition,
} from "./contact";
import { appScope } from "./store";

export const contactScope = appScope.child("contact");
/** Circle radius in millimetres; drag the same value in the SVG or equation. */
export const radius = control({
  scope: contactScope,
  value: 60,
  ...CONTACT_LIMITS.radius,
  unit: "mm",
});
export const position = contactScope.durableSignal<ContactPoint>("position", { x: -30, y: 140 });
export const tangentHeld = contactScope.durableSignal("tangent-held", false);
export const contactSelection = contactScope.durableSignal<ContactFeature | null>(
  "selection",
  null,
);
export function contactInput() {
  return { position: position.get(), radius: radius.get(), locked: tangentHeld.get() };
}
/** Move the circle in model millimetres. While tangency is held, only the along-line coordinate moves.
 * @example {"x":40,"y":80}
 */
export const moveCircle = action({
  scope: contactScope,
  name: "move-circle",
  params: { x: "Along-line coordinate in mm", y: "Height above the line in mm" },
  run(args) {
    flush();
    if (
      typeof args?.x !== "number" ||
      typeof args.y !== "number" ||
      !Number.isFinite(args.x) ||
      !Number.isFinite(args.y)
    )
      throw new Error("Supply finite x and y coordinates.");
    const next = movePosition({ x: args.x, y: args.y }, radius.get(), tangentHeld.get());
    flush(() =>
      position.set((previous) =>
        previous.x === next.x && previous.y === next.y ? previous : next,
      ),
    );
    return circleLineContact(contactInput());
  },
});
/** Enable or release the exact relation h=r. Releasing retains the current centre position.
 * @example {"enabled":true}
 */
export const holdTangency = action({
  scope: contactScope,
  name: "hold-tangency",
  params: { enabled: "Whether to maintain tangency" },
  run(args) {
    flush();
    if (typeof args?.enabled !== "boolean") throw new Error("enabled must be boolean.");
    const enabled = args.enabled;
    const center = circleLineContact(contactInput()).center;
    flush(() => {
      position.set({ x: center.x, y: enabled ? radius.get() : center.y });
      tangentHeld.set(enabled);
    });
    return circleLineContact(contactInput());
  },
});
/** Put the circle at tangency once, keeping free dragging enabled. */
export const touchLine = action({
  scope: contactScope,
  name: "touch-line",
  run() {
    flush();
    flush(() => {
      position.set({ x: position.get().x, y: radius.get() });
      tangentHeld.set(false);
    });
    return circleLineContact(contactInput());
  },
});
/** Select the same geometric quantity in the drawing and equation. */
export const selectContact = action({
  scope: contactScope,
  name: "select-feature",
  params: { feature: "circle, radius, height, gap, normal, tangent, or null" },
  run(args) {
    const feature = args?.feature;
    if (feature !== null && !CONTACT_FEATURES.includes(feature as ContactFeature))
      throw new Error("Unknown contact feature.");
    flush(() => contactSelection.set(feature as ContactFeature | null));
    return { feature };
  },
});
/** Restore the initial free circle. */
export const resetContact = action({
  scope: contactScope,
  name: "reset",
  run() {
    flush(() => {
      radius.set(60);
      position.set({ x: -30, y: 140 });
      tangentHeld.set(false);
      contactSelection.set(null);
    });
    return circleLineContact(contactInput());
  },
});
/** Inspect contact geometry and its declared numerical scope; this is not a dynamics simulation. */
export const inspectContact = action({
  scope: contactScope,
  name: "inspect",
  kind: "read",
  run() {
    flush();
    return {
      ...circleLineContact(contactInput()),
      selection: contactSelection.get(),
      units: "mm",
      authoringStep: 0.5,
      geometry: "circle above infinite horizontal line y=0",
    };
  },
});
