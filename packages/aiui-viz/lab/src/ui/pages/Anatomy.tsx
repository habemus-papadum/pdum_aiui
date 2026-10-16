/**
 * Anatomy.tsx — any Mermaid source, rendered, with its anatomy laid bare:
 * what became addressable (every node, edge, cluster by the id the author
 * wrote), what a pointer lands on, what the render cost. Edit the text and
 * the diagram follows (latest-wins; a broken line keeps the last good
 * drawing and shows the parse error). Click an element to pin a note on it.
 */
import { TOKENS } from "@habemus-papadum/aiui-design";
import {
  Mermaid,
  type MermaidHit,
  type MermaidMark,
  type MermaidRenderInfo,
} from "@habemus-papadum/aiui-viz/site/mermaid";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { ANATOMY_PRESETS, source } from "../../model/store";

export function Anatomy(): JSX.Element {
  const [hit, setHit] = createSignal<MermaidHit | undefined>();
  const [pinned, setPinned] = createSignal<MermaidHit | undefined>();
  const [info, setInfo] = createSignal<MermaidRenderInfo | undefined>();
  const [showHits, setShowHits] = createSignal(false);

  const marks = (): Record<string, MermaidMark> => {
    const p = pinned();
    if (p === undefined) return {};
    return {
      [p.id]: {
        active: true,
        color: TOKENS.accent,
        note: (
          <span class="mmd-lab-chip">
            {p.kind} <b>{p.id}</b>
          </span>
        ),
        place: p.kind === "edge" ? "right" : "below",
      },
    };
  };
  const counts = () => {
    const ids = info()?.ids ?? [];
    const n = (k: string) => ids.filter((x) => x.kind === k).length;
    return { node: n("node"), edge: n("edge"), cluster: n("cluster") };
  };

  return (
    <article class="rtx-lab-page">
      <header>
        <p class="eyebrow">anatomy</p>
        <h1>What a diagram makes addressable</h1>
        <p class="lede">
          Mermaid writes the author's ids into the SVG it returns — a node, an edge, a subgraph each
          come back findable by the name in the text, across diagram types. Edit the source; hover
          the drawing; click an element to pin a note on it. The list is what the component
          recovered after the last render, with its cost.
        </p>
      </header>

      <div class="mmd-lab-presets">
        <For each={Object.keys(ANATOMY_PRESETS)}>
          {(k) => (
            <button
              type="button"
              class="btn"
              onClick={() => {
                setPinned(undefined);
                source.set(ANATOMY_PRESETS[k] as string);
              }}
            >
              {k}
            </button>
          )}
        </For>
        <label class="small muted">
          <input
            type="checkbox"
            checked={showHits()}
            onChange={(e) => setShowHits(e.currentTarget.checked)}
          />{" "}
          show edge hit areas
        </label>
      </div>

      <div class="mmd-lab-anatomy-grid">
        <div>
          <textarea
            class="mmd-lab-source"
            spellcheck={false}
            value={source.get()}
            onInput={(e) => source.set(e.currentTarget.value)}
          />
          <p class="mmd-lab-readout">
            <Show when={info()} fallback="rendering…">
              {(i) => (
                <>
                  rendered in <b>{i().ms.toFixed(0)} ms</b> · {counts().node} nodes, {counts().edge}{" "}
                  edges, {counts().cluster} clusters
                </>
              )}
            </Show>
          </p>
          <p class="mmd-lab-readout">
            <Show when={hit()} fallback="hover the diagram">
              {(h) => (
                <>
                  under the pointer: {h().kind} <b>{h().id}</b>
                </>
              )}
            </Show>
          </p>
          <ul class="mmd-lab-ids">
            <For each={info()?.ids ?? []}>
              {(x) => (
                <li data-hot={hit()?.id === x.id && hit()?.kind === x.kind ? "true" : undefined}>
                  <span class="mmd-lab-kind">{x.kind}</span>
                  {x.id}
                </li>
              )}
            </For>
          </ul>
        </div>

        <Mermaid
          class={showHits() ? "mmd-lab-diagram mmd-lab-show-hits" : "mmd-lab-diagram"}
          text={source.get()}
          marks={marks()}
          onHover={setHit}
          onClick={(h) => setPinned((p) => (p?.id === h.id && p.kind === h.kind ? undefined : h))}
          onRender={setInfo}
        />
      </div>
    </article>
  );
}
