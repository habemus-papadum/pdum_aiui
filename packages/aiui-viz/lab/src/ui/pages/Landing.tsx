/** The lab's front page: each component under test in one live sample, and
 * the pages that exercise it. */
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site";
import { Mermaid, type MermaidHit, type MermaidMark } from "@habemus-papadum/aiui-viz/site/mermaid";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { HUE } from "../hues";
import { NAV } from "../nav";

const RICH_TEX_PAGES = new Set(["fidelity", "training", "derivation", "fourier"]);

const SAMPLE = `flowchart LR
  text["the diagram's text"] e_render@--> render["Mermaid renders it"]
  render e_ids@--> ids["ids recovered from the markup"]
  ids e_marks@--> marks["marks, notes, knobs by id"]
  marks e_back@-->|"a change to the text"| text`;

export function Landing(): JSX.Element {
  const [hot, setHot] = createSignal<string | undefined>();
  const piece = (id: keyof typeof HUE, tex: string, note: string) => (
    <Term
      id={id}
      color={HUE[id]}
      active={hot() === id}
      onHover={(h) => setHot(h ? id : undefined)}
      note={<span class="rtx-lab-chip">{note}</span>}
    >
      {tex}
    </Term>
  );

  const [hit, setHit] = createSignal<MermaidHit | undefined>();
  const marks = (): Record<string, MermaidMark> => {
    const h = hit();
    if (h === undefined) return {};
    return {
      [h.id]: {
        active: true,
        note: (
          <span class="mmd-lab-chip">
            {h.kind} <b>{h.id}</b>
          </span>
        ),
        place: h.kind === "edge" ? "above" : "below",
      },
    };
  };

  const pages = (richTex: boolean) => (
    <ul>
      {NAV.filter((n) => RICH_TEX_PAGES.has(n.id) === richTex).map((n) => (
        <li>
          <a href={n.href}>{n.name}</a> — {n.desc}
        </li>
      ))}
    </ul>
  );

  return (
    <article class="lab-page">
      <header class="landing-head">
        <p class="eyebrow">aiui-viz · lab</p>
        <h1>The site lab</h1>
        <p class="lede">
          Rigs for the site components whose pieces stay addressable after a library has drawn them:
          an equation, over KaTeX; a diagram, over Mermaid. The SVG work is meant to join them here.
        </p>
      </header>

      <section>
        <h2>RichTeX — an equation built from pieces</h2>
        <RichTeX display class="rtx-lab-eq rtx-lab-eq-hero">
          {"E ="}
          {piece("policy", "m", "mass")}
          {piece("kl", "c^{2}", "the speed of light, squared")}
        </RichTeX>
        <div class="measure">
          <p>
            <code>TeX</code> takes one string and renders one opaque block. <code>RichTeX</code>{" "}
            takes children — TeX strings and <code>&lt;Term&gt;</code>s — and wraps each term in
            KaTeX's own <code>\htmlData</code> command, so every term comes back as a span the page
            can find. KaTeX looks through those spans when it spaces atoms, so the layout is the
            plain render's, to the pixel. Decorations touch only the term's span; a change to the
            TeX re-renders the equation; notes sit in a layer under or over the glyphs they belong
            to, with a leader line. Hover a term above.
          </p>
          {pages(true)}
        </div>
      </section>

      <section>
        <h2>Mermaid — a diagram as a control surface</h2>
        <Mermaid class="mmd-lab-diagram" text={SAMPLE} marks={marks()} onHover={setHit} />
        <div class="measure">
          <p>
            Mermaid's syntax names its nodes and edges, and Mermaid writes those names into the SVG
            it returns; the component recovers them, so every element can be clicked, hovered,
            decorated, annotated or dragged as a knob by the id the author wrote. A change to the
            text re-renders — the layout is the cost; a mark touches one element. Hover the diagram
            above.
          </p>
          {pages(false)}
        </div>
      </section>
    </article>
  );
}
