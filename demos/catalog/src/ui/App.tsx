/**
 * App.tsx — the catalog page: a title block that says what the page is and
 * how to read it, then the catalog file rendered shelf by shelf with the live
 * specimens hung on their entries, the right-hand rail of shelves, and the
 * stamp inspector at the foot. TocRail builds its rail from the section[id] >
 * h2 headings the Catalog component emits.
 */
import { TocRail } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";
import { parseCatalog, rewriteLinks } from "../model/catalog";
import { CATALOG_MD, CATALOG_URL } from "../model/catalog-source";
import { SPECIMEN_KEYS } from "../model/specimen-keys";
import { Catalog } from "./Catalog";
import { StampInspector } from "./StampInspector";

/** Parsed once per module load — the text is a build-time constant. */
const DOC = parseCatalog(rewriteLinks(CATALOG_MD, CATALOG_URL));

export function App(): JSX.Element {
  return (
    <div class="catalog app">
      <main class="app-main">
        <header class="app-head cat-head">
          <p class="eyebrow">aiui-viz · the catalog</p>
          <h1>What aiui-viz provides</h1>
          <p class="lede">
            The package's catalog, rendered as a page: the substrate every piece is built from, the
            components a page is written with, the containers that hold them, the agent surface that
            crosses all three, and the sister packages — with the piece itself shown under every
            entry that can be shown.
          </p>
          <p class="measure-wide cat-how">
            The text is <code>packages/aiui-viz/CATALOG.md</code>, read at build time, so this page
            and the file cannot disagree; its links lead to the repo. An entry marked{" "}
            <span class="cat-badge cat-badge-live">live below</span> carries the real component over
            this page's one piece of state — a damped wave with a frequency, a damping and a shape —
            so moving a slider, a pill, a knob in the equation or a node in the diagram moves every
            other specimen too. <b class="numeric">{SPECIMEN_KEYS.length}</b> of the entries are
            live. Hover inside any specimen for the stamps an agent reads; the badge on each entry
            is the catalog's own state: <span class="cat-badge cat-badge-shipped">shipped</span> is
            used by a notebook or a sister package,{" "}
            <span class="cat-badge cat-badge-spike">spike</span> is in the library with a lab page
            only, <span class="cat-badge cat-badge-proposed">proposed</span> is a design document.
          </p>
        </header>
        <Catalog doc={DOC} />
      </main>
      <TocRail />
      <StampInspector />
    </div>
  );
}
