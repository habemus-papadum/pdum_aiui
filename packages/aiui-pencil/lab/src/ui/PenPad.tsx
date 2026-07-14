/**
 * PenPad.tsx — the bridge between the reactive graph and two imperative islands:
 * the **paper** (the real `PencilSurface`) and the **diagnostic overlay** on top
 * of it.
 *
 * The component draws nothing itself. Its job is the pushes:
 *
 *   graph → island   createEffect(source, handler) → a plain setter. The handler
 *                    is untracked for reads too, so it consumes the value the
 *                    source computed and never re-reads a signal.
 *   island → graph   ONE write per completed stroke, and a telemetry snapshot
 *                    four times a second. Never per sample.
 *
 * The paper owns pointer input (it is the thing being drawn on); the overlay sits
 * above it with `pointer-events: none` and merely reports.
 */

import { adopt } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createEffect, untrack } from "solid-js";
import { currentParams, graph, rebake } from "../model/graph";
import {
  fadeSec,
  fillDabs,
  pad,
  paper,
  recorder,
  showCusps,
  showDabs,
  showFiltered,
  showRaw,
  telemetry,
} from "../model/store";

export function PenPad(): JSX.Element {
  // ── graph → the diagnostic overlay ─────────────────────────────────────────
  createEffect(
    () => graph().plans.latest(),
    (plans) => pad.setPlans(plans ?? []),
  );

  createEffect(
    () => currentParams(),
    (params) => pad.setParams(params),
  );

  createEffect(
    () => ({
      raw: showRaw.get(),
      filtered: showFiltered.get(),
      cusps: showCusps.get(),
      dabs: showDabs.get(),
      fill: fillDabs.get(),
    }),
    (view) => pad.setView(view),
  );

  // ── graph → the paper ──────────────────────────────────────────────────────
  //
  // A raster surface bakes its strokes to pixels, so a knob cannot retroactively
  // change ink that is already down — the only way is to throw the pixels away
  // and re-run the pipeline from the raw samples. That is what `rebake` does, and
  // it is why the Lab keeps raw samples at all.
  //
  // Note the dependency set: parameters and fade — but deliberately NOT `strokes`,
  // and NOT `tool`.
  //
  //  - not `strokes`, because re-baking at every pen-up would tear down and rebuild
  //    the surface to replace a stroke it had just drawn perfectly well, flashing
  //    as it went;
  //  - not `tool`, because the tool belongs to each stroke, not to the page. It is
  //    read when a stroke BEGINS and remembered. Depending on it here is what made
  //    switching to the eraser retroactively turn every existing pencil stroke into
  //    an eraser stroke, and wipe the page.
  createEffect(
    () => ({ params: currentParams(), fade: fadeSec.get() }),
    () => {
      // `untrack` because re-baking READS the whole store (every stroke, every
      // knob) and must not subscribe to any of it: the trigger is the source
      // above, deliberately narrow. Without it Solid warns
      // [STRICT_READ_UNTRACKED] — reads in an effect HANDLER are untracked, so a
      // dependency you appear to take here would silently never fire.
      untrack(() => rebake.run?.());
    },
  );

  pad.setRecorder(recorder);

  // `adopt()` is called HERE, in the component body — which is the whole point of
  // it. Cleanup registered inside a ref callback runs with no reactive owner and
  // is silently dropped, so the pen listeners would survive every hot swap and
  // stack up, until a single stroke committed itself half a dozen times. (They
  // did. That is why `adopt` exists.)
  return (
    <div
      class="pad"
      ref={adopt((host) => {
        // The paper goes in FIRST (underneath), the overlay on top. Both islands
        // own their own canvas — they are framework-free, and the same
        // `PencilSurface` has to run on a plain iPad page with no Solid at all —
        // so this is plain `adopt`, not `durableCanvas`.
        host.append(paper.canvas);
        paper.setActive(true);
        pad.mount(host);

        // ── island → graph ─────────────────────────────────────────────────
        // The recorder listens on the SAME canvas the paper draws on, but ONLY to
        // measure telemetry. Strokes are recorded by the surface itself (see
        // store.ts), because the surface is the only thing that knows a stroke's
        // tool — and two independent captures of the same pen is exactly how the
        // tool went missing in the first place.
        const detach = recorder.attach(paper.canvas, {
          onTelemetry: (t) => telemetry.set(t),
        });

        return () => {
          detach();
          pad.unmount(host);
        };
      })}
    />
  );
}
