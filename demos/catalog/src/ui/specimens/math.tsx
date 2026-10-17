/**
 * math.tsx — specimens for shelves 2.2 and 2.3: one TeX string, an equation
 * built from pieces with two knobs and notes, and a diagram of this very
 * page's dataflow as a control surface — click a node, drag a knob.
 */
import { CHART, TOKENS } from "@habemus-papadum/aiui-design";
import { RichTeX, Term, TeX } from "@habemus-papadum/aiui-viz/site";
import { Mermaid, type MermaidHit, type MermaidMark } from "@habemus-papadum/aiui-viz/site/mermaid";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import { graph } from "../../model/graph";
import { damping, frequency, selectedNode, selectNode, shape } from "../../model/store";

export function TeXSpecimen(): JSX.Element {
  return (
    <>
      <TeX display tex="y(t) = e^{-\zeta t}\,\sin(2\pi f t)" />
      <p class="cat-note">
        Inline, the same component follows the controls:{" "}
        <TeX
          tex={`f = ${frequency.get().toFixed(1)}\\,\\mathrm{Hz},\\quad \\zeta = ${damping.get().toFixed(2)}\\,\\mathrm{s}^{-1}`}
        />
        . One string in, one block out, stamped <code>data-tex</code> so <code>read-page</code>{" "}
        gives it back as TeX. The pieces are not addressable — that is what RichTeX adds.
      </p>
    </>
  );
}

const WAVE_TEX: Record<string, string> = {
  sine: "\\sin(2\\pi f t)",
  square: "\\operatorname{sgn}\\!\\big(\\sin(2\\pi f t)\\big)",
  triangle: "\\operatorname{tri}(f t)",
};

export function RichTeXSpecimen(): JSX.Element {
  const [hot, setHot] = createSignal<string | undefined>();
  const hover = (id: string) => (h: boolean) => setHot(h ? id : undefined);
  const carrier = (): string => {
    const tex = WAVE_TEX[shape.get()] ?? WAVE_TEX.sine;
    return tex.replace("f t", "FREQ t"); // the knob is spliced in below
  };
  return (
    <>
      <RichTeX display class="cat-eq">
        {"y(t) = "}
        <Term
          id="envelope"
          color={CHART.amber}
          active={hot() === "envelope"}
          onHover={hover("envelope")}
          note={
            <span class="cat-chip">
              envelope · ζ = <b>{damping.get().toFixed(2)}</b>
            </span>
          }
        >
          {"e^{-"}
          <Term control={damping} format={(v) => `${v.toFixed(2)} /s`}>
            {"\\zeta"}
          </Term>
          {" t}"}
        </Term>
        {"\\,"}
        <Term
          id="carrier"
          color={CHART.blue}
          active={hot() === "carrier"}
          onHover={hover("carrier")}
          note={
            <span class="cat-chip">
              {shape.get()} · f = <b>{frequency.get().toFixed(1)}</b> Hz
            </span>
          }
        >
          {carrier().split("FREQ")[0]}
          <Term control={frequency} format={(v) => `${v.toFixed(1)} Hz`}>
            {"f"}
          </Term>
          {carrier().split("FREQ")[1]}
        </Term>
      </RichTeX>
      <p class="cat-note">
        Hover a term: it highlights and its note brightens. Drag <TeX tex="\zeta" /> or{" "}
        <TeX tex="f" /> sideways: they are knobs on the same controls as the sliders (arrow keys
        when focused). Change the shape above and the carrier's TeX changes — a re-render; every
        decoration comes back by id. Select across the equation and copy: the clipboard carries the
        covered terms' TeX.
      </p>
    </>
  );
}

// The page's own dataflow, as the diagram's text. Ids are plain words so they
// survive Mermaid's id recovery; `end`, `graph` and the like are avoided.
const DATAFLOW = `flowchart LR
  subgraph controls["controls · store.ts"]
    frequency(["f · frequency"])
    damping(["ζ · damping"])
    waveform(["shape"])
  end
  subgraph cells["cells · graph.ts"]
    samples["samples"]
    summary["summary"]
  end
  subgraph components["components · ui/"]
    plot["PlotFigure"]
    equation["RichTeX"]
    prose["CellText · CellView"]
  end
  agent{{"an agent"}}
  frequency --> samples
  damping --> samples
  waveform --> samples
  samples --> summary
  samples --> plot
  frequency -.-> equation
  damping -.-> equation
  summary --> prose
  agent -.-> controls`;

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ["frequency", "samples"],
  ["damping", "samples"],
  ["waveform", "samples"],
  ["samples", "summary"],
  ["samples", "plot"],
  ["frequency", "equation"],
  ["damping", "equation"],
  ["summary", "prose"],
  ["agent", "controls"],
];
const edgeId = (from: string, to: string): string => `L_${from}_${to}_0`;

const NODES = [
  "frequency",
  "damping",
  "waveform",
  "samples",
  "summary",
  "plot",
  "equation",
  "prose",
  "agent",
] as const;

export function MermaidSpecimen(): JSX.Element {
  const [hover, setHover] = createSignal<MermaidHit | undefined>();

  /** What a node's note says right now — a value, a state, or a role. */
  const readout = (id: string): JSX.Element => {
    switch (id) {
      case "frequency":
        return <b>{frequency.get().toFixed(1)} Hz</b>;
      case "damping":
        return <b>{damping.get().toFixed(2)} /s</b>;
      case "waveform":
        return <b>{shape.get()}</b>;
      case "samples":
        return <b>{graph().samples.state()}</b>;
      case "summary":
        return <b>{graph().summary.state()}</b>;
      case "agent":
        return <b>set · report · randomize</b>;
      default:
        return <b>a component</b>;
    }
  };

  const marks = createMemo((): Record<string, MermaidMark> => {
    const sel = selectedNode.get();
    const h = hover();
    const focus = h?.kind === "node" ? h.id : sel;
    const m: Record<string, MermaidMark> = {};
    for (const id of NODES) {
      const shown = id === sel || (h?.kind === "node" && h.id === id);
      m[id] = {
        active: id === sel,
        color: h?.kind === "node" && h.id === id ? TOKENS.accent : undefined,
        fill: id === sel ? "var(--accent-wash, #e9e7f8)" : undefined,
        control: id === "frequency" ? frequency : id === "damping" ? damping : undefined,
        span: 200,
        ...(shown
          ? {
              note: (
                <span class="cat-chip">
                  {id} · {readout(id)}
                </span>
              ),
            }
          : {}),
      };
    }
    for (const [from, to] of EDGES) {
      const lit = focus !== undefined && (from === focus || to === focus);
      m[edgeId(from, to)] = { color: lit ? TOKENS.accent : undefined, active: lit };
    }
    return m;
  });

  const onClick = (hit: MermaidHit): void => {
    if (hit.kind === "node") selectNode(hit.id);
    else if (hit.kind === "edge") {
      const e = EDGES.find(([f, t]) => edgeId(f, t) === hit.id);
      selectNode(e?.[1]);
    } else selectNode(undefined);
  };

  return (
    <>
      <Mermaid
        class="cat-diagram"
        text={DATAFLOW}
        marks={marks()}
        onClick={onClick}
        onHover={setHover}
      />
      <p class="cat-note">
        This page's own dataflow. Click a node to select it (its note shows the live value or
        state); hover one to light its edges. Drag <code>frequency</code> or <code>damping</code>{" "}
        sideways — they are knobs on the same controls as everything else here. The text is
        structural; every mark touches attributes only, so nothing re-lays out.
      </p>
    </>
  );
}
