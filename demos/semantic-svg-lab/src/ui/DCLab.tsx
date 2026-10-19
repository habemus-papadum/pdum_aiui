import "../dc.css";
import { CellView, ControlToggle } from "@habemus-papadum/aiui-viz";
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site/rich-tex";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  analyzeDC,
  type DCEdit,
  type DCResult,
  dcLabel,
  missingReturn,
  netTerms,
  PARTS,
  type PartId,
  PINS,
  type PinId,
  pinRef,
  type ResistorId,
  validDCRef,
  wireRef,
} from "../model/dc-circuit";
import { type DCLayout, moveDCPart } from "../model/dc-layout";
import {
  beginDCReturn,
  changeDC,
  dcAnchor,
  dcHistory,
  dcLayout,
  dcNotice,
  dcSelection,
  loadDCCase,
  moveDCSymbol,
  redoDC,
  resetDCLayout,
  returnRequest,
  selectDC,
  terminalNames,
  undoDC,
  voltageLens,
} from "../model/dc-store";
import { graph } from "../model/graph";
import { DCPencil } from "./DCPencil";
import { amps, DCScene, volts } from "./DCScene";
import { TargetedDiagnostics } from "./TargetedDiagnostics";

interface Interaction {
  active: string;
  select: (ref: string) => void;
  hover: (ref: string | null) => void;
  attempt: (work: () => unknown) => void;
}
function commit(edit: DCEdit, revision = dcHistory.get().current.revision) {
  return changeDC.run({ expectedRevision: revision, edit });
}
function DCBoard(props: Interaction & { result: DCResult }) {
  const [connecting, setConnecting] = createSignal(false),
    [first, setFirst] = createSignal<PinId | null>(null),
    [draft, setDraft] = createSignal<DCLayout | null>(null);
  const layout = createMemo(() => draft() ?? dcLayout.get());
  const selectedWire = createMemo(() =>
    props.result.model.wires.find((w) => wireRef(w.id) === dcSelection.get()),
  );
  let svg!: SVGSVGElement;
  let drag:
    | {
        part: PartId;
        pointer: number;
        source: DCLayout;
        startX: number;
        startY: number;
        x: number;
        y: number;
        moved: boolean;
      }
    | undefined;
  let ignoreClick = false;
  const point = (e: PointerEvent) => {
    const matrix = svg.getScreenCTM();
    return matrix ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse()) : null;
  };
  function start(e: PointerEvent, part: PartId) {
    if (connecting() || e.button !== 0 || drag) return;
    e.preventDefault();
    const p = point(e);
    if (!p) return;
    svg.querySelector<SVGGElement>(`[data-ref="part/${part}"]`)?.focus();
    const source = dcLayout.get();
    drag = {
      part,
      pointer: e.pointerId,
      source,
      startX: p.x,
      startY: p.y,
      ...source[part],
      moved: false,
    };
    svg.setPointerCapture(e.pointerId);
    props.select(`part/${part}`);
  }
  function move(e: PointerEvent) {
    if (!drag || drag.pointer !== e.pointerId) return;
    const p = point(e);
    if (!p) return;
    if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 3) drag.moved = true;
    if (drag.moved) {
      drag.x = drag.source[drag.part].x + p.x - drag.startX;
      drag.y = drag.source[drag.part].y + p.y - drag.startY;
      setDraft(moveDCPart(drag.source, drag.part, drag.x, drag.y));
    }
  }
  function end(cancel = false) {
    if (!drag) return;
    const last = drag;
    drag = undefined;
    ignoreClick = last.moved;
    if (!cancel && last.moved)
      props.attempt(() => {
        if (dcLayout.get() !== last.source)
          throw new Error("The layout changed during this gesture. Try the move again.");
        moveDCSymbol.run({ part: last.part, x: last.x, y: last.y });
      });
    setDraft(null);
    if (svg.hasPointerCapture(last.pointer)) svg.releasePointerCapture(last.pointer);
  }
  function keyboard(e: KeyboardEvent, part: PartId) {
    if (e.key === "Escape") {
      end(true);
      setConnecting(false);
      setFirst(null);
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const p = dcLayout.get()[part],
      step = e.shiftKey ? 30 : 10;
    props.attempt(() => moveDCSymbol.run({ part, x: p.x + d[0] * step, y: p.y + d[1] * step }));
  }
  function choose(ref: string) {
    if (ignoreClick) {
      ignoreClick = false;
      return;
    }
    if (connecting() && ref.startsWith("pin/")) {
      const pin = ref.slice(4) as PinId,
        from = first();
      if (!from) {
        setFirst(pin);
        props.select(ref);
      } else if (from === pin) setFirst(null);
      else
        props.attempt(() => {
          commit({ kind: "connect", a: from, b: pin });
          setFirst(null);
          setConnecting(false);
          props.select(pinRef(pin));
        });
    } else props.select(ref);
  }
  return (
    <div>
      <div class="svg-lab-figure-heading">
        <span>Schematic</span>
        <span>electrical revision {props.result.model.revision}</span>
      </div>
      <div class="svg-dc-plate">
        <svg
          ref={svg}
          class="svg-dc-board"
          viewBox="0 0 720 460"
          aria-label="Editable voltage divider"
          onPointerMove={move}
          onPointerUp={() => end()}
          onPointerCancel={() => end(true)}
          onLostPointerCapture={() => end(true)}
        >
          <title>
            Select a wire to disconnect it. Connect named terminals, or drag a component to
            rearrange the drawing.
          </title>
          <DCScene
            result={props.result}
            layout={layout()}
            active={props.active}
            anchor={dcAnchor.get()}
            lens={voltageLens.get()}
            names={terminalNames.get()}
            from={first()}
            select={choose}
            hover={props.hover}
            drag={start}
            keyboard={keyboard}
          />
        </svg>
      </div>
      <div class="svg-dc-drawing-tools">
        <button
          class="btn btn-outline"
          type="button"
          aria-pressed={connecting() ? "true" : "false"}
          onClick={() => {
            setConnecting(!connecting());
            setFirst(null);
          }}
        >
          {connecting() ? "Cancel wiring" : "Connect terminals"}
        </button>
        <Show when={selectedWire()}>
          {(wire) => (
            <button
              class="btn btn-outline"
              type="button"
              onClick={() => props.attempt(() => commit({ kind: "disconnect", wire: wire().id }))}
            >
              Disconnect {wire().id.toUpperCase()}
            </button>
          )}
        </Show>
        <span role="status">
          {connecting()
            ? first()
              ? `From ${first()} → choose another terminal`
              : "Choose the first terminal"
            : "Drag symbols to rearrange · arrow keys also work"}
        </span>
      </div>
      <div class="svg-dc-legend">
        <span class="svg-dc-low">● 0 V</span>
        <span class="svg-dc-high">● {props.result.model.supply} V</span>
        <span>○ unresolved</span>
        <span>halo = selected electrical net</span>
      </div>
      <p class="svg-lab-caption">
        Connections follow terminal IDs. Moving, crossing or overlapping symbols and wires never
        creates a connection.
      </p>
    </div>
  );
}
function DCNetView(props: Interaction & { result: DCResult }) {
  const result = createMemo(() => props.result),
    anchor = createMemo(() => dcAnchor.get());
  const net = createMemo(() => result().nets[result().netOf[anchor()]]);
  const pins = createMemo(() => net().pins, {
    equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  });
  const terms = createMemo(() => netTerms(result(), anchor()), {
    equals: (a, b) =>
      a.length === b.length &&
      a.every(
        (t, i) =>
          t.ref === b[i].ref &&
          t.symbol === b[i].symbol &&
          t.sign === b[i].sign &&
          t.current === b[i].current,
      ),
  });
  const height = () => Math.max(170, 70 + pins().length * 43);
  const allKnown = () =>
    result().status !== "short" &&
    result().status !== "numerical" &&
    terms().every((t) => t.current !== null);
  return (
    <aside class="svg-dc-net-view">
      <div class="svg-lab-figure-heading">
        <span>Net through {anchor()}</span>
        <span>{pins().length} terminals</span>
      </div>
      <div class="svg-dc-plate">
        <svg viewBox={`0 0 360 ${height()}`} aria-label={`Electrical net through ${anchor()}`}>
          <title>Separated terminal appearances belonging to one electrical net</title>
          <line
            class="svg-dc-net-bus"
            x1="245"
            x2="245"
            y1="35"
            y2={35 + (pins().length - 1) * 43}
          />
          <For each={pins()}>
            {(pin, index) => (
              // biome-ignore lint/a11y/useSemanticElements: keyboard-selectable SVG terminal in a derived net projection.
              <g
                class="svg-dc-net-terminal"
                data-ref={pinRef(pin)}
                data-active={props.active === pinRef(pin) ? "true" : undefined}
                role="button"
                tabindex="0"
                aria-label={`Net terminal ${pin}`}
                onClick={() => props.select(pinRef(pin))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.select(pinRef(pin));
                  }
                }}
              >
                <line x1="107" x2="245" y1={35 + index() * 43} y2={35 + index() * 43} />
                <circle cx="100" cy={35 + index() * 43} r="7" />
                <text x="82" y={40 + index() * 43} text-anchor="end">
                  {pin}
                </text>
              </g>
            )}
          </For>
          <text class="svg-dc-net-voltage" x="245" y={height() - 18} text-anchor="middle">
            {volts(net().voltage)}
          </text>
        </svg>
      </div>
      <p class="svg-lab-caption">
        These terminals are one electrical point, separated here for inspection. The view follows{" "}
        {anchor()} when a wire splits or merges the net.
      </p>
      <label class="svg-dc-anchor">
        Inspect through{" "}
        <select
          aria-label="Inspect terminal"
          value={anchor()}
          onChange={(e) => props.select(pinRef(e.currentTarget.value as PinId))}
        >
          <For each={PINS}>{(pin) => <option value={pin}>{pin}</option>}</For>
        </select>
      </label>
      <div class="svg-dc-net-wires">
        <span>Wires in this net:</span>
        <For
          each={result()
            .model.wires.filter((w) => result().netOf[w.a] === result().netOf[anchor()])
            .map((w) => w.id)}
        >
          {(id) => (
            <button type="button" class="btn btn-outline" onClick={() => props.select(wireRef(id))}>
              {id.toUpperCase()}
            </button>
          )}
        </For>
      </div>
      <div class="svg-dc-kcl">
        <p class="svg-lab-eyebrow">Current balance · outward is positive</p>
        <Show
          when={result().status !== "short" && result().status !== "numerical"}
          fallback={
            <p>The ideal source constraint is unresolved. No current values are assigned.</p>
          }
        >
          <RichTeX display>
            {terms().map((term, i) => [
              i ? (term.sign > 0 ? " + " : " - ") : term.sign < 0 ? "-" : "",
              <Term
                id={`dc-kcl-${term.ref.replaceAll("/", "-")}`}
                active={props.active === term.ref}
                onClick={() => props.select(term.ref)}
                onHover={(on) => props.hover(on ? term.ref : null)}
              >
                {term.symbol}
              </Term>,
            ])}
            {terms().length ? " = 0" : "0 = 0"}
          </RichTeX>
          <div class="svg-dc-current-list">
            <For each={terms()}>
              {(term) => (
                <button
                  type="button"
                  data-ref={term.ref}
                  aria-pressed={props.active === term.ref ? "true" : "false"}
                  onClick={() => props.select(term.ref)}
                >
                  <span>{term.ref.slice(5)}</span>
                  <span>{amps(term.current === null ? null : term.sign * term.current)}</span>
                </button>
              )}
            </For>
          </div>
          <p class="svg-lab-caption" data-dc-kcl>
            {allKnown()
              ? `Sum = ${amps(terms().reduce((sum, t) => sum + t.sign * (t.current ?? 0), 0))}`
              : "Unknown currents remain symbolic."}
          </p>
        </Show>
      </div>
    </aside>
  );
}
function DCInspector(props: Interaction & { result: DCResult }) {
  const selected = createMemo(() => dcSelection.get());
  const wire = createMemo(() => props.result.model.wires.find((w) => wireRef(w.id) === selected()));
  const [wireDraft, setWireDraft] = createSignal<{
    a: PinId;
    b: PinId;
    target: string | null;
    revision: number;
  } | null>(null);
  const a = () => wireDraft()?.a ?? wire()?.a ?? "R2/b";
  const b = () => wireDraft()?.b ?? wire()?.b ?? "V1/n";
  function draftEndpoint(end: "a" | "b", pin: PinId) {
    const current = wireDraft() ?? {
      a: a(),
      b: b(),
      target: wire()?.id ?? null,
      revision: dcHistory.get().current.revision,
    };
    setWireDraft({ ...current, [end]: pin });
  }
  let valueRevision = 0;
  const [part, setPart] = createSignal<PartId>("R1"),
    [value, setValue] = createSignal<string | null>(null);
  const actual = () =>
    part() === "V1"
      ? props.result.model.supply
      : props.result.model.resistance[part() as ResistorId];
  return (
    <section class="svg-dc-inspector" aria-label="Circuit inspector">
      <div class="svg-dc-inspector-heading">
        <h3>Inspect & edit</h3>
        <span>{dcLabel(props.result.model, selected())}</span>
      </div>
      <div class="svg-dc-inspector-grid">
        <div>
          <p class="svg-lab-eyebrow">Connections</p>
          <div class="svg-dc-wire-list">
            <For each={props.result.model.wires.map((w) => w.id)}>
              {(id) => (
                <button
                  class="btn btn-outline"
                  type="button"
                  aria-pressed={selected() === wireRef(id) ? "true" : "false"}
                  onClick={() => props.select(wireRef(id))}
                >
                  {id.toUpperCase()}
                </button>
              )}
            </For>
          </div>
          <Show when={wire()}>
            {(current) => (
              <p>
                {current().a} ↔ {current().b}. Reconnecting keeps {current().id.toUpperCase()}’s
                identity.
              </p>
            )}
          </Show>
          <div class="svg-dc-reconnect">
            <label>
              From{" "}
              <select
                aria-label="Wire first terminal"
                value={a()}
                onChange={(e) => draftEndpoint("a", e.currentTarget.value as PinId)}
              >
                <For each={PINS}>{(pin) => <option value={pin}>{pin}</option>}</For>
              </select>
            </label>
            <label>
              To{" "}
              <select
                aria-label="Wire second terminal"
                value={b()}
                onChange={(e) => draftEndpoint("b", e.currentTarget.value as PinId)}
              >
                <For each={PINS}>{(pin) => <option value={pin}>{pin}</option>}</For>
              </select>
            </label>
            <button
              class="btn btn-outline"
              type="button"
              onClick={() =>
                props.attempt(() => {
                  const current = wireDraft() ?? {
                    a: a(),
                    b: b(),
                    target: wire()?.id ?? null,
                    revision: dcHistory.get().current.revision,
                  };
                  if (current.target !== (wire()?.id ?? null))
                    throw new Error("The selected wire changed. Reset endpoints before applying.");
                  commit(
                    current.target
                      ? { kind: "reconnect", wire: current.target, a: current.a, b: current.b }
                      : { kind: "connect", a: current.a, b: current.b },
                    current.revision,
                  );
                  setWireDraft(null);
                })
              }
            >
              {wire() ? "Reconnect selected wire" : "Add wire"}
            </button>
            <Show when={!!wireDraft()}>
              <button class="btn btn-outline" type="button" onClick={() => setWireDraft(null)}>
                Reset endpoints
              </button>
            </Show>
          </div>
        </div>
        <div>
          <p class="svg-lab-eyebrow">Component values</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              props.attempt(() => {
                const draft = value();
                if (draft === null || !draft.trim()) return;
                const p = part();
                commit(
                  p === "V1"
                    ? { kind: "supply", volts: Number(draft) }
                    : { kind: "resistance", part: p, ohms: Number(draft) },
                  valueRevision,
                );
                setValue(null);
              });
            }}
          >
            <label>
              Component{" "}
              <select
                aria-label="Value component"
                value={part()}
                onChange={(e) => {
                  setPart(e.currentTarget.value as PartId);
                  setValue(null);
                }}
              >
                <For each={PARTS}>{(p) => <option value={p}>{p}</option>}</For>
              </select>
            </label>
            <label>
              {part() === "V1" ? "Volts" : "Ohms"}{" "}
              <input
                aria-label="Component value"
                type="number"
                min={part() === "V1" ? 1 : 100}
                max={part() === "V1" ? 24 : 100000}
                step={part() === "V1" ? 0.001 : 1}
                value={value() ?? actual()}
                onInput={(e) => {
                  if (value() === null) valueRevision = dcHistory.get().current.revision;
                  setValue(e.currentTarget.value);
                }}
              />
            </label>
            <button type="submit" class="btn btn-outline">
              Apply value
            </button>
            <Show when={value() !== null}>
              <button class="btn btn-outline" type="button" onClick={() => setValue(null)}>
                Reload value
              </button>
            </Show>
          </form>
          <p class="svg-lab-caption">
            Values and connections are electrical edits. Symbol positions are presentation.
          </p>
        </div>
      </div>
    </section>
  );
}
export function DCLab() {
  const [hovered, setHovered] = createSignal<string | null>(null);
  const active = () => {
    const ref = hovered();
    return ref && validDCRef(dcHistory.get().current, ref) ? ref : dcSelection.get();
  };
  const attempt = (work: () => unknown) => {
    try {
      work();
      dcNotice.set("");
    } catch (error) {
      dcNotice.set(error instanceof Error ? error.message : String(error));
    }
  };
  const select = (ref: string) => attempt(() => selectDC.run({ ref }));
  return (
    <section class="svg-dc" aria-label="Editable circuit study">
      <div class="svg-dc-task">
        <strong>Keep 6 V at OUT with the load connected.</strong> Disconnect W3, inspect what
        changes, then reconnect the return. Compare that with isolating the load or shorting the
        supply.
      </div>
      <div class="svg-lab-toolbar">
        <ControlToggle of={voltageLens} label="Voltage lens" />
        <ControlToggle of={terminalNames} label="Terminal names" />
        <button
          type="button"
          class="btn btn-outline"
          disabled={!dcHistory.get().past.length}
          onClick={() => attempt(() => undoDC.run())}
        >
          Undo circuit edit
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={!dcHistory.get().future.length}
          onClick={() => attempt(() => redoDC.run())}
        >
          Redo circuit edit
        </button>
        <button
          type="button"
          class="btn btn-outline"
          disabled={!!returnRequest.get() || !missingReturn(analyzeDC(dcHistory.get().current))}
          onClick={() => attempt(() => beginDCReturn.run())}
        >
          Sketch return
        </button>
        <button type="button" class="btn btn-outline" onClick={() => resetDCLayout.run()}>
          Reset layout
        </button>
      </div>
      <div class="svg-dc-cases">
        <span>Load a case:</span>
        <For
          each={
            [
              ["working", "Working divider"],
              ["open-return", "Open return"],
              ["floating-load", "Isolated load"],
              ["source-short", "Shorted supply"],
            ] as const
          }
        >
          {([key, label]) => (
            <button
              type="button"
              class="btn btn-outline"
              onClick={() => attempt(() => loadDCCase.run({ case: key }))}
            >
              {label}
            </button>
          )}
        </For>
        <span class="svg-lab-caption">Replaces the circuit; Undo restores your edit.</span>
      </div>
      <Show when={!!dcNotice.get()}>
        <p role="alert" class="svg-dc-notice">
          {dcNotice.get()}
        </p>
      </Show>
      <CellView of={graph().dc}>
        {(result) => (
          <>
            <div
              class="svg-dc-summary"
              data-state={result().status}
              data-goal={result().goalMet ? "true" : "false"}
            >
              <div>
                <span class="svg-lab-eyebrow">OUT · R2/a</span>
                <output data-dc-output>{volts(result().output)}</output>
                <span>
                  {result().goalMet
                    ? "Target met"
                    : result().status === "short"
                      ? "Supply constraint inconsistent"
                      : result().status === "numerical"
                        ? "Numerical result unresolved"
                        : result().loadConnected
                          ? "Outside the 6 V target"
                          : "Load is not across OUT and ground"}
                </span>
              </div>
              <div>
                <span class="svg-lab-eyebrow">Supply current</span>
                <output>{amps(result().sourceCurrent)}</output>
                <span>delivered by V1</span>
              </div>
              <div>
                <span class="svg-lab-eyebrow">Load current</span>
                <output>{amps(result().branches.RL.current)}</output>
                <span>RL · a → b</span>
              </div>
            </div>
            <TargetedDiagnostics
              items={result().diagnostics}
              label={(ref) => dcLabel(result().model, ref)}
              select={select}
              class="svg-dc-diagnostics"
            />
            <div class="svg-dc-layout">
              <DCBoard
                result={result()}
                active={active()}
                select={select}
                hover={setHovered}
                attempt={attempt}
              />
              <DCNetView
                result={result()}
                active={active()}
                select={select}
                hover={setHovered}
                attempt={attempt}
              />
            </div>
            <DCInspector
              result={result()}
              active={active()}
              select={select}
              hover={setHovered}
              attempt={attempt}
            />
          </>
        )}
      </CellView>
      <Show when={!!returnRequest.get()}>
        <DCPencil attempt={attempt} />
      </Show>
      <div class="svg-dc-prompts">
        <h3>Compare the failure modes</h3>
        <div class="svg-lab-prompts">
          <p>
            <strong>Open return.</strong> A voltage can be defined without a working load path.
            Follow R2/b’s net, then sketch or wire it back to V1/n.
          </p>
          <p>
            <strong>Isolated load.</strong> OUT changes to the unloaded-divider value. RL’s floating
            voltages remain unknown while the referenced circuit stays readable.
          </p>
          <p>
            <strong>Shorted supply.</strong> Ideal wires contradict the voltage source. Inspect the
            diagnostic and remove the extra bypass wire.
          </p>
        </div>
      </div>
      <p class="svg-dc-scope">
        One ideal DC voltage source, three positive resistors and explicit ideal wires. Voltages are
        relative to V1/n. This uses a small numerical nodal solve, without AC, transients,
        tolerances or per-wire current allocation. Session-only study; pencil interpretation is
        scripted.
      </p>
    </section>
  );
}
