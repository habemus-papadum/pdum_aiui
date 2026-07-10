/**
 * ErrorReadout.tsx — the error norms against the analytic reference, rendered
 * through CellView so the `errors` cell's gating shows honestly: for the
 * gaussian IC it reads `ready`; for every other IC the cell is `held` and the
 * fallback names the reason instead of pretending to load.
 */
import { CellView } from "@habemus-papadum/aiui-viz";
import { Show } from "solid-js";
import { graph } from "../model/graph";
import { ic } from "../model/store";

export function ErrorReadout() {
  return (
    <div class="error-readout">
      <Show
        when={ic.get() === "gaussian"}
        fallback={
          <p class="muted">
            error norms need the analytic reference — switch the profile to <b>gaussian</b>
          </p>
        }
      >
        <CellView of={graph().errors} label="comparing to the analytic solution">
          {(e) => (
            <p>
              vs. free-space gaussian at t = {e().t.toFixed(4)} s: L2 ={" "}
              <b>{e().l2.toExponential(2)}</b>, max = <b>{e().max.toExponential(2)}</b>
            </p>
          )}
        </CellView>
      </Show>
    </div>
  );
}
