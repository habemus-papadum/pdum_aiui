import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { createSignal, onCleanup } from "solid-js";
import { appScope, capture, targets } from "./store";
export const graph = hotCellGraph(
  appScope.name,
  () => {
    const [snapshot, setSnapshot] = createSignal(capture.snapshot(), { ownedWrite: true });
    onCleanup(capture.subscribe(setSnapshot));
    const status = cell(
      () => snapshot(),
      (value) => value,
      { scope: appScope },
    );
    /** Stop capture and release the screen. */
    action({ scope: appScope, name: "stop-capture", run: () => capture.stop() });
    /** Restore the full selected surface without reopening the browser picker. */
    action({ scope: appScope, name: "clear-crop", run: () => capture.setTarget(null) });
    /** Crop an active capture to the chart's rectangle. Start sharing this tab with the page button first. */
    action({
      scope: appScope,
      name: "crop-chart",
      run: () => {
        const element = targets.get("chart");
        if (!element) throw new Error("The chart is not mounted.");
        return capture.setTarget({ element, label: "Wave chart", mode: "region" });
      },
    });
    /** Isolate the chart, excluding the sibling annotation. Requires Element Capture support. */
    action({
      scope: appScope,
      name: "isolate-chart",
      run: () => {
        const element = targets.get("chart");
        if (!element) throw new Error("The chart is not mounted.");
        return capture.setTarget({ element, label: "Wave chart", mode: "element" });
      },
    });
    /** Read capture status and browser capabilities. */
    action({
      scope: appScope,
      name: "capture-state",
      kind: "read",
      run: () => ({ ...capture.snapshot(), capabilities: capture.capabilities() }),
    });
    return { status };
  },
  import.meta.hot,
);
export type AppGraph = ReturnType<typeof graph>;
registerStandardTools(
  agentToolkit(appScope.name, {
    brief:
      "Local screen-capture demonstration. A human starts capture with Share screen and chooses this tab. Crop or isolate the chart; vary width, visibility, overlap, and motion. Read capture-state, clear-crop, or stop-capture. No media leaves this page.",
  }),
);

// Vite's static import analysis must see the accept call in this module.
if (import.meta.hot) import.meta.hot.accept();
