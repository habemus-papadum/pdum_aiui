import { createScreenCapture } from "@habemus-papadum/aiui-screen-capture";
import { control, scope } from "@habemus-papadum/aiui-viz";
export const appScope = scope("screen-capture");
export const capture = appScope.durable("capture", () => createScreenCapture());
export const targets = appScope.durable("targets", () => new Map<string, HTMLElement>());
/** Change the width of the chart to see the crop follow its layout. */
export const width = control({
  scope: appScope,
  value: 100,
  min: 50,
  max: 100,
  step: 1,
  unit: "%",
});
/** Move the chart's scanning line. */
export const motion = control({ scope: appScope, value: true });
/** Place a sibling annotation over the chart to compare crop modes. */
export const overlap = control({ scope: appScope, value: false });
/** Temporarily hide the chart without removing its capture target. */
export const visible = control({ scope: appScope, value: true });
