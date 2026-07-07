/**
 * Breadcrumb.tsx — the path of the open file plus the symbol the cursor sits in
 * (derived from the outline cell + the coarse cursor signal). Clicking a path
 * segment does nothing structural yet; the symbol chip reveals the enclosing
 * symbol.
 */
import { For, Show } from "solid-js";
import { codeGraph } from "../model/graph";
import { reader } from "../model/store";
import type { OutlineItem } from "../model/types";
import { kindGlyph } from "./Outline";

function enclosingSymbol(items: OutlineItem[], line: number | undefined): OutlineItem | undefined {
  if (line === undefined) return undefined;
  let best: OutlineItem | undefined;
  for (const item of items) {
    const { start, end } = item.range;
    if (line >= start.line && line <= end.line) {
      if (!best || item.depth >= best.depth) best = item;
    }
  }
  return best;
}

export function Breadcrumb() {
  const segments = () => {
    const file = reader.currentFile();
    return file ? file.split("/") : [];
  };
  const symbol = () => {
    const items = codeGraph()?.outline.latest();
    return items ? enclosingSymbol(items, reader.cursor()?.line) : undefined;
  };
  return (
    <div class="breadcrumb" data-cell="outline">
      <Show
        when={reader.currentFile()}
        fallback={<span class="breadcrumb-empty">no file open</span>}
      >
        <For each={segments()}>
          {(seg, i) => (
            <>
              <Show when={i() > 0}>
                <span class="breadcrumb-sep">›</span>
              </Show>
              <span class="breadcrumb-seg">{seg}</span>
            </>
          )}
        </For>
        <Show when={symbol()}>
          {(s) => (
            <>
              <span class="breadcrumb-sep">›</span>
              <button
                type="button"
                class="breadcrumb-symbol"
                onClick={() => reader.reveal(s().selectionRange)}
              >
                <span class="tree-icon">{kindGlyph(s().kind)}</span>
                {s().name}
              </button>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
