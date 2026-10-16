/** Observed pen capabilities and accepted-input measurements. */

import type { Range, TiltVerdict } from "@habemus-papadum/aiui-pencil";
import { CellView } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { graph, resetTelemetry } from "../model/graph";
import { inputDecisions } from "../model/store";

/** Verdicts that mean the tilt design survives. */
const ALIVE = new Set<TiltVerdict>(["native", "derived"]);

function span(range: Range, digits = 3): string {
  if (range.count === 0) {
    return "—";
  }
  const width = range.max - range.min;
  const moved = width > 1e-6;
  return `${range.min.toFixed(digits)} … ${range.max.toFixed(digits)}${moved ? "" : "  (never moved)"}`;
}

export function Readout(): JSX.Element {
  return (
    <section class="panel" id="telemetry">
      <h2>Pen telemetry</h2>
      <p class="hint" data-input-decisions>
        {inputDecisions.get().accepted} accepted / {inputDecisions.get().observed} observed samples.{" "}
        {inputDecisions.get().last}
      </p>
      <CellView of={graph().verdict} label="telemetry">
        {(report) => (
          <>
            <div
              class={`verdict verdict-${report().verdict}`}
              data-cell="verdict"
              data-verdict={report().verdict}
            >
              <strong>{report().verdict.toUpperCase()}</strong>
              <span>{report().says}</span>
            </div>

            <div
              class={`verdict verdict-input-${report().input.level}`}
              data-input-level={report().input.level}
              data-can-coalesce={String(report().input.canCoalesce)}
            >
              <strong>INPUT — {report().input.headline}</strong>
              <span>{report().input.says}</span>
            </div>

            <table class="telemetry">
              <tbody>
                <tr>
                  <th>pointer</th>
                  <td>{report().telemetry.support?.kind ?? "—"}</td>
                </tr>
                <tr>
                  <th>reports</th>
                  <td>
                    {[
                      report().telemetry.support?.spherical === true
                        ? "altitude/azimuth"
                        : undefined,
                      report().telemetry.support?.tilt === true ? "tiltX/tiltY" : undefined,
                      report().telemetry.support?.twist === true ? "twist" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "nothing"}
                  </td>
                </tr>
                <tr>
                  <th>pressure</th>
                  <td>{span(report().telemetry.pressure)}</td>
                </tr>
                <tr class={ALIVE.has(report().verdict) ? "live-row" : undefined}>
                  <th>altitude</th>
                  <td>{span(report().telemetry.altitude)} rad</td>
                </tr>
                <tr class={ALIVE.has(report().verdict) ? "live-row" : undefined}>
                  <th>azimuth</th>
                  <td>{span(report().telemetry.azimuth)} rad</td>
                </tr>
                <tr>
                  <th>twist</th>
                  <td>
                    {report().telemetry.support?.twist === true
                      ? `${span(report().telemetry.twist, 1)}°`
                      : "not reported"}
                  </td>
                </tr>
                <tr>
                  <th>sample rate (median)</th>
                  <td>
                    {report().telemetry.rateHz.toFixed(0)} Hz
                    {report().telemetry.medianIntervalMs > 0
                      ? ` — ${report().telemetry.medianIntervalMs.toFixed(1)} ms`
                      : ""}
                  </td>
                </tr>
                <tr>
                  <th>peak rate</th>
                  <td>{report().telemetry.peakRateHz.toFixed(0)} Hz</td>
                </tr>
                <tr>
                  <th>coalescing</th>
                  <td>
                    {report().telemetry.events > 0
                      ? `${report().telemetry.coalescingRatio.toFixed(2)}×`
                      : "—"}
                  </td>
                </tr>
                <tr
                  class={
                    report().telemetry.support?.coalescedApi === false ? "warn-row" : undefined
                  }
                >
                  <th>getCoalescedEvents</th>
                  <td>
                    {report().telemetry.support === undefined
                      ? "—"
                      : report().telemetry.support?.coalescedApi === true
                        ? "present"
                        : "ABSENT"}
                  </td>
                </tr>
                <tr>
                  <th>getPredictedEvents</th>
                  <td>
                    {report().telemetry.support === undefined
                      ? "—"
                      : report().telemetry.support?.predictedApi === true
                        ? "present"
                        : "absent"}
                  </td>
                </tr>
                <tr>
                  <th>samples / events</th>
                  <td>
                    {report().telemetry.samples} / {report().telemetry.events}
                  </td>
                </tr>
                <tr>
                  <th>predicted available</th>
                  <td>
                    {report().telemetry.predicted > 0
                      ? `yes — ${report().telemetry.predicted} seen`
                      : "no (or none offered yet)"}
                  </td>
                </tr>
              </tbody>
            </table>

            <button type="button" class="btn" onClick={() => resetTelemetry.run?.()}>
              Reset & re-measure
            </button>
            <p class="hint">
              Reset, then <b>tilt the pencil right over</b> and draw. If altitude and azimuth do not
              move, this device gives us no tilt — and the charcoal half of the design is dead here.
            </p>
            <p class="hint">
              The rate is a <b>median of gaps between samples</b>, with idle gaps thrown out — so
              idle time does not lower the reported rate. Coalescing of 1.00× means one actual
              sample per event. API availability and the measured rate provide the context for that
              number.
            </p>
          </>
        )}
      </CellView>
    </section>
  );
}
