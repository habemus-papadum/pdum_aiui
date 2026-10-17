/**
 * components.tsx — specimens for shelf 2.1: the control widgets, the scrub
 * pill, CellView's states, CellText in a sentence, and the refresh-aware
 * Dropdown. Every one is the real component over the page's wave.
 */
import {
  CellText,
  CellView,
  ControlScrub,
  ControlSelect,
  ControlSlider,
  ControlToggle,
  Dropdown,
} from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { graph } from "../../model/graph";
import {
  breakSummary,
  damping,
  frequency,
  refreshes,
  shape,
  showEnvelope,
} from "../../model/store";

export function WidgetsSpecimen(): JSX.Element {
  return (
    <>
      <div class="cat-row">
        <ControlSlider of={frequency} label="frequency" format={(v) => v.toFixed(1)} />
        <ControlSlider of={damping} label="damping" format={(v) => v.toFixed(2)} />
        <ControlSelect of={shape} label="shape" />
        <ControlToggle of={showEnvelope} label="show the envelope" />
      </div>
      <p class="cat-note">
        Bounds, step, unit and options come from the declarations in <code>store.ts</code>; the doc
        comment is each widget's tooltip; each root carries <code>data-control</code>. The same
        controls are moved by the pill, the knobs and the diagram below — and by an agent's{" "}
        <code>set</code>.
      </p>
    </>
  );
}

export function ScrubSpecimen(): JSX.Element {
  return (
    <p class="cat-note cat-note-lead">
      Hold the frequency at <ControlScrub of={frequency} label="f" format={(v) => v.toFixed(1)} />{" "}
      and drag the damping toward{" "}
      <ControlScrub of={damping} label="ζ" format={(v) => v.toFixed(2)} /> — a fixed drag length
      crosses the declared range, so every pill feels the same.
    </p>
  );
}

export function CellViewSpecimen(): JSX.Element {
  return (
    <>
      <div class="cat-row">
        <ControlToggle of={breakSummary} label="break the summary cell" />
        <ControlSlider
          of={frequency}
          label="frequency"
          class="slider-compact"
          format={(v) => v.toFixed(1)}
        />
      </div>
      <div class="panel">
        <CellView of={graph().summary} keepLatest label="summary">
          {(v) => (
            <p>
              Over two seconds the wave has an RMS of <b class="numeric">{v().rms.toFixed(3)}</b>, a
              peak of <b class="numeric">{v().peak.toFixed(3)}</b>, and crosses zero{" "}
              <b class="numeric">{v().crossings}</b> times.
            </p>
          )}
        </CellView>
      </div>
      <p class="cat-note">
        Move the slider: the last render dims under an accent progress stripe while the slow cell
        re-runs. Flip the switch: the error surface, with Retry.
      </p>
    </>
  );
}

export function CellTextSpecimen(): JSX.Element {
  return (
    <p class="cat-note cat-note-lead">
      The wave crosses zero{" "}
      <CellText of={graph().summary}>{(v) => <b class="numeric">{v.crossings}</b>}</CellText> times
      in two seconds, with an RMS of{" "}
      <CellText of={graph().summary}>{(v) => <b class="numeric">{v.rms.toFixed(3)}</b>}</CellText> —
      numbers inside a sentence that keep their last value through a re-run and never flash chrome.
      Each span carries the same <code>data-cell</code> stamps as a CellView.
    </p>
  );
}

export function DropdownSpecimen(): JSX.Element {
  const stamp = (): string => new Date().toLocaleTimeString();
  return (
    <>
      <div class="cat-row">
        <Dropdown
          class="btn btn-outline"
          label="refresh log"
          trigger={
            <>
              opened <b class="numeric">{refreshes.get().length}</b>{" "}
              {refreshes.get().length === 1 ? "time" : "times"} ▾
            </>
          }
          onOpen={() => refreshes.set((l) => [...l.slice(-4), stamp()])}
        >
          {(close) => (
            <div class="cat-dropdown">
              <p class="cat-dropdown-head">refreshed on open</p>
              <Show when={refreshes.get().length > 0} fallback={<p class="muted">—</p>}>
                <ul>
                  <For each={refreshes.get()}>{(t) => <li class="numeric">{t}</li>}</For>
                </ul>
              </Show>
              <button type="button" class="btn btn-outline" onClick={close}>
                close
              </button>
            </div>
          )}
        </Dropdown>
      </div>
      <p class="cat-note">
        Every open fires <code>onOpen</code> — here it appends the time, so the list is current at
        the moment it is looked at. The widget owns only the popup's lifecycle; the trigger and the
        body are the page's.
      </p>
    </>
  );
}
