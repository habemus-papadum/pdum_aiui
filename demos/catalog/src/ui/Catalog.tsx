/**
 * Catalog.tsx — the parsed catalog, rendered. Sections become `<section id>`
 * with an `h2` (what TocRail builds its rail from); `###` headings stay inside
 * their shelf as `h3`s. Prose, lists and plain tables render as the design
 * system's elements, with inline Markdown through `marked`. Two blocks are
 * special: a ```mermaid fence is drawn live by the catalogued `Mermaid`
 * component (hover a node), and a PIECE TABLE becomes a list of entries —
 * name, state badge, what it is, where and seen-in — each hanging the live
 * specimen registered for its key, if there is one.
 *
 * The document is a build-time constant, so the blocks are rendered by plain
 * functions over static data (`.map`, `switch`) rather than reactive control
 * flow — no memo per block, no wide-scope insert effect. Only the specimens
 * are components.
 */
import { Mermaid, type MermaidHit, type MermaidMark } from "@habemus-papadum/aiui-viz/site/mermaid";
import { Dynamic, type JSX } from "@solidjs/web";
import { marked } from "marked";
import { type Component, createSignal } from "solid-js";
import {
  type Block,
  type CatalogDoc,
  isPieceTable,
  type PieceRow,
  pieceRows,
  type Section,
} from "../model/catalog";
import { SECTION_SPECIMENS, SPECIMENS } from "./specimens";

/** Inline Markdown (code spans, links, emphasis) to HTML. The text is the
 * repo's own file, so it is rendered as written. */
export function inline(md: string): string {
  return marked.parseInline(md, { async: false }) as string;
}

const specimenFor = (key: string): Component | undefined =>
  (SPECIMENS as Partial<Record<string, Component>>)[key];
const sectionSpecimenFor = (id: string): Component | undefined =>
  (SECTION_SPECIMENS as Partial<Record<string, Component>>)[id];

/** A fenced diagram in the text, drawn by the component the catalog lists. */
function MermaidFence(props: { text: string }): JSX.Element {
  const [hit, setHit] = createSignal<MermaidHit | undefined>();
  const marks = (): Record<string, MermaidMark> => {
    const h = hit();
    if (h === undefined) return {};
    return {
      [h.id]: {
        active: true,
        note: (
          <span class="cat-chip">
            {h.kind} <b>{h.id}</b>
          </span>
        ),
        place: h.kind === "edge" ? "above" : "below",
      },
    };
  };
  return (
    <figure class="cat-figure">
      <Mermaid class="cat-diagram" text={props.text} marks={marks()} onHover={setHit} />
      <figcaption>
        The catalog's own diagram, rendered by the <code>Mermaid</code> it lists — hover a shelf.
      </figcaption>
    </figure>
  );
}

function Entry(props: { row: PieceRow }): JSX.Element {
  const Specimen = specimenFor(props.row.key);
  const state = props.row.state.primary ?? "unknown";
  return (
    <article class="cat-entry" id={`piece-${props.row.key}`} data-state={state}>
      <header class="cat-entry-head">
        <span class="cat-entry-name" innerHTML={inline(props.row.name)} />
        <span class={`cat-badge cat-badge-${state}`}>{props.row.state.label}</span>
        {Specimen && <span class="cat-badge cat-badge-live">live below</span>}
      </header>
      <p class="cat-entry-what" innerHTML={inline(props.row.what)} />
      <dl class="cat-entry-meta">
        <dt>where</dt>
        <dd innerHTML={inline(props.row.where)} />
        <dt>seen in</dt>
        <dd innerHTML={inline(props.row.seenIn || "—")} />
      </dl>
      {Specimen && (
        <div class="cat-specimen">
          <span class="cat-specimen-tag">live</span>
          <Specimen />
        </div>
      )}
    </article>
  );
}

function renderBlock(b: Block): JSX.Element {
  switch (b.kind) {
    case "paragraph":
      return <p class="measure-wide" innerHTML={inline(b.text)} />;
    case "heading":
      return (
        <h3 id={b.id} class="cat-sub">
          <span innerHTML={inline(b.text)} />
        </h3>
      );
    case "list":
      return (
        <Dynamic component={b.ordered ? "ol" : "ul"} class="cat-list">
          {b.items.map((item) => (
            <li innerHTML={inline(item)} />
          ))}
        </Dynamic>
      );
    case "code":
      return b.lang === "mermaid" ? (
        <MermaidFence text={b.text} />
      ) : (
        <pre>
          <code>{b.text}</code>
        </pre>
      );
    case "table":
      return isPieceTable(b.header) ? (
        <div class="cat-entries">
          {pieceRows(b).map((row) => (
            <Entry row={row} />
          ))}
        </div>
      ) : (
        <div class="cat-table">
          <table>
            <thead>
              <tr>
                {b.header.map((h) => (
                  <th innerHTML={inline(h)} />
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row) => (
                <tr>
                  {row.map((cell) => (
                    <td innerHTML={inline(cell)} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function SectionView(props: { section: Section }): JSX.Element {
  const Tail = sectionSpecimenFor(props.section.id);
  return (
    <section id={props.section.id} class="cat-section">
      <h2>
        <span innerHTML={inline(props.section.title)} />
      </h2>
      {props.section.blocks.map(renderBlock)}
      {Tail && (
        <div class="cat-specimen cat-specimen-section">
          <span class="cat-specimen-tag">live</span>
          <Tail />
        </div>
      )}
    </section>
  );
}

export function Catalog(props: { doc: CatalogDoc }): JSX.Element {
  return (
    <>
      <div class="cat-preamble">{props.doc.preamble.map(renderBlock)}</div>
      {props.doc.sections.map((s) => (
        <SectionView section={s} />
      ))}
    </>
  );
}
