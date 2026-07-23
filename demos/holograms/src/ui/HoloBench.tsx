/**
 * HoloBench.tsx — the star apparatus, phase-switched: RECORD shows both beams
 * alive in space and the film line integrating; PLAYBACK shows the reference
 * alone re-lit through the developed film, the reconstructed wave fanning
 * out, the twin converging — and, floating over the *incoming* side where no
 * light computes at all, the ghost dots marking where the virtual images
 * stand. You cannot photograph that region; you can only look through the
 * film — which is exactly what the eye row below does.
 *
 * Scene points are draggable on the record map (nearest-point drag). Pure
 * reader otherwise: maps and numbers from the graph, controls from the store.
 */
import { FieldMap, FilmStrip } from "@habemus-papadum/aiui-optics/widgets";
import { CellView, ControlSlider, ControlToggle } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { EYE_STANDOFF } from "../model/bench";
import { graph } from "../model/graph";
import {
  eyeFocus,
  eyeX,
  lambdaRec,
  objGain,
  playback,
  refAngleDeg,
  scenePoints,
  showWave,
  windowCenter,
  windowWidth,
} from "../model/store";
import { css, MapDot, PlaneLine, Ray } from "./overlays";
import { RetinaChart } from "./RetinaChart";

/** Drag handler: move the nearest scene point to the pointer (record phase). */
function dragPoint(p: { x: number; z: number }): void {
  const pts = scenePoints.get();
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot((pts[i].x - p.x) * 2.2, pts[i].z - p.z); // x weighted (map is anisotropic)
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0 || bestD > 260) return;
  const next = pts.slice();
  next[best] = {
    x: Math.max(-140, Math.min(140, Math.round(p.x))),
    z: Math.max(-1080, Math.min(-380, Math.round(p.z))),
  };
  scenePoints.set(next);
}

function SplitChips() {
  return (
    <CellView of={graph().split} label="beam split">
      {(v) => (
        <div class="readouts">
          <div>
            <span class="rd-num">{(v().image * 100).toFixed(1)}%</span>
            <span class="rd-lbl">into the image beam</span>
          </div>
          <div>
            <span class="rd-num">{(v().zero * 100).toFixed(0)}%</span>
            <span class="rd-lbl">straight through (zero order)</span>
          </div>
          <div>
            <span class="rd-num">{(v().twin * 100).toFixed(1)}%</span>
            <span class="rd-lbl">into the conjugate twin</span>
          </div>
        </div>
      )}
    </CellView>
  );
}

export function RecordMap(props: { draggable?: boolean }) {
  return (
    <CellView of={graph().recordMap} label="recording bench">
      {(v) => (
        <div class="map-wrap">
          <FieldMap
            data={v()}
            view={showWave.get() ? "wave" : "intensity"}
            aspect={760 / 560}
            onProbe={props.draggable ? dragPoint : undefined}
            overlay={
              <g>
                <PlaneLine z={0} xHalf={330} color="rgba(207, 200, 180, 0.85)" dash="1 0" />
                {/* the reference beam's direction, sketched entering top-left */}
                <Ray
                  from={{ z: -1100, x: 300 }}
                  sin={-Math.sin((refAngleDeg.get() * Math.PI) / 180)}
                  color="rgba(150, 158, 172, 0.5)"
                />
                <Ray
                  from={{ z: -1100, x: 120 }}
                  sin={-Math.sin((refAngleDeg.get() * Math.PI) / 180)}
                  color="rgba(150, 158, 172, 0.5)"
                />
              </g>
            }
          />
          <For each={scenePoints.get()}>
            {(p, i) => (
              <MapDot
                extent={v()}
                z={p.z}
                x={p.x}
                kind="source"
                color="#f0a35e"
                label={`P${i() + 1}`}
              />
            )}
          </For>
        </div>
      )}
    </CellView>
  );
}

export function PlaybackMap(props: { showEye?: boolean; showGhosts?: boolean }) {
  const ghosts = () => graph().ghosts() ?? [];
  return (
    <CellView of={graph().playbackMap} label="playback bench">
      {(v) => (
        <div class="map-wrap">
          <FieldMap
            data={v()}
            view={showWave.get() ? "wave" : "intensity"}
            aspect={760 / 560}
            overlay={
              <g data-cell="holograms/ghosts">
                <PlaneLine z={0} xHalf={330} color="rgba(207, 200, 180, 0.85)" dash="1 0" />
                <Show when={props.showEye}>
                  <PlaneLine z={EYE_STANDOFF} xHalf={330} color="rgba(140,150,170,0.35)" />
                </Show>
              </g>
            }
          />
          <Show when={props.showGhosts !== false}>
            <For each={ghosts()}>
              {(g, i) => (
                <>
                  <Show when={g.image.kind === "virtual"}>
                    <MapDot
                      extent={v()}
                      z={g.image.z ?? 0}
                      x={g.image.x ?? 0}
                      kind="ghost"
                      label={i() === 0 ? "virtual image (look through!)" : undefined}
                    />
                  </Show>
                  <Show when={g.twin.kind === "real"}>
                    <MapDot
                      extent={v()}
                      z={g.twin.z ?? 0}
                      x={g.twin.x ?? 0}
                      kind="twin"
                      label={i() === 0 ? "twin focus" : undefined}
                    />
                  </Show>
                </>
              )}
            </For>
          </Show>
          <Show when={props.showEye}>
            <MapDot extent={v()} z={EYE_STANDOFF} x={eyeX.get()} kind="probe" label="eye" />
          </Show>
        </div>
      )}
    </CellView>
  );
}

/** The § overview bench: phase toggle, map, film strip, and the eye row. */
export function HoloBench() {
  return (
    <div class="bench">
      <div class="bench-stage">
        <Show when={playback.get()} fallback={<RecordMap draggable />}>
          <PlaybackMap showEye />
        </Show>
        <p class="map-caption">
          <Show
            when={playback.get()}
            fallback={
              <>
                RECORD: the reference (gray rays) and the glow of the object points cross on the
                film line — drag the orange points; the standing fringe pattern is what the film
                integrates
              </>
            }
          >
            PLAYBACK: the object is gone; the reference alone crosses the developed film. Dashed
            circles: where the paraxial equations put each virtual image (no light computes there —
            only an eye looking through sees them) and each twin focus
          </Show>
        </p>
      </div>

      <div class="bench-side">
        <div class="controls">
          <ControlToggle of={playback} label="PLAYBACK (develop the film, remove the object)" />
          <ControlToggle of={showWave} label="traveling wave (off = what film sees)" />
          <ControlSlider
            of={refAngleDeg}
            label="reference angle"
            format={(v) => `${v.toFixed(1)}°`}
          />
          <ControlSlider of={lambdaRec} label="wavelength λ" format={(v) => `${v.toFixed(1)} µm`} />
          <ControlSlider
            of={objGain}
            label="object brightness"
            format={(v) => `${v.toFixed(1)}×`}
          />
        </div>
        <CellView of={graph().benchNumbers} label="bench numbers">
          {(v) => (
            <div class="readouts">
              <div>
                <span class="rd-num">{v().finest.toFixed(0)} µm</span>
                <span class="rd-lbl">finest fringe this recording writes</span>
              </div>
              <div>
                <span class="rd-num">{(v().contrast * 100).toFixed(0)}%</span>
                <span class="rd-lbl">fringe contrast achieved</span>
              </div>
            </div>
          )}
        </CellView>
        <Show when={playback.get()}>
          <SplitChips />
        </Show>
      </div>

      <div class="bench-chart">
        <Show
          when={playback.get()}
          fallback={
            <>
              <CellView of={graph().exposure} label="film exposure">
                {(v) => (
                  <FilmStrip
                    data={v().exposure}
                    x0={v().x0}
                    dx={v().dx}
                    color={v().tint}
                    normalize="mean"
                    height={40}
                  />
                )}
              </CellView>
              <p class="map-caption">
                the film line, magnified: the fringes being integrated (whole film, ±768 µm)
              </p>
            </>
          }
        >
          <EyeRow />
        </Show>
      </div>
    </div>
  );
}

/** The eye on the rail: retina chart + its two knobs. Used by several sections. */
export function EyeRow() {
  const ghosts = () => graph().ghosts() ?? [];
  return (
    <div class="eye-row">
      <CellView of={graph().eyeView} label="what the eye sees">
        {(v) => (
          <RetinaChart
            xApparent={v().xApparent}
            intensity={v().intensity}
            color={css(v().tint)}
            eyeX={eyeX.get()}
            ghosts={ghosts()
              .filter((g) => g.image.kind === "virtual")
              .map((g, i) => ({ x: g.image.x ?? 0, label: `P${i + 1}` }))}
          />
        )}
      </CellView>
      <div class="controls eye-controls" data-cell="holograms/eyeView">
        <ControlSlider of={eyeX} label="eye position (parallax!)" format={(v) => `${v} µm`} />
        <ControlSlider of={eyeFocus} label="focus depth" format={(v) => `${v} µm`} />
        <ControlSlider of={windowCenter} label="film window centre" format={(v) => `${v} µm`} />
        <ControlSlider of={windowWidth} label="film window width" format={(v) => `${v} µm`} />
      </div>
    </div>
  );
}
