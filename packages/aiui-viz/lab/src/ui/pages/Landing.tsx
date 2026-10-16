/** The lab's front page: what RichTeX is, in one live equation. */
import { RichTeX, Term } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { HUE } from "../hues";
import { NAV } from "../nav";

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

  return (
    <article class="rtx-lab-page">
      <header class="landing-head">
        <p class="eyebrow">aiui-viz · lab</p>
        <h1>RichTeX</h1>
        <p class="lede">
          An equation built from pieces, each piece still addressable after KaTeX has drawn it:
          styled, hovered, annotated, reactive. Hover a term below.
        </p>
      </header>

      <RichTeX display class="rtx-lab-eq rtx-lab-eq-hero">
        {"E ="}
        {piece("policy", "m", "mass")}
        {piece("kl", "c^{2}", "the speed of light, squared")}
      </RichTeX>

      <section class="measure">
        <p>
          <code>TeX</code> takes one string and renders one opaque block. <code>RichTeX</code> takes
          children — TeX strings and <code>&lt;Term&gt;</code>s — and wraps each term in KaTeX's own{" "}
          <code>\htmlData</code> command, so every term comes back as a span the page can find.
          KaTeX looks through those spans when it spaces atoms, so the layout is the plain render's,
          to the pixel. Decorations touch only the term's span; a change to the TeX re-renders the
          equation; notes sit in a layer under or over the glyphs they belong to, with a leader
          line.
        </p>
        <ul>
          {NAV.map((n) => (
            <li>
              <a href={n.href}>{n.name}</a> — {n.desc}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
