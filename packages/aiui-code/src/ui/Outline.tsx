/**
 * Outline.tsx — the current file's document-symbol tree (real LSP), a click
 * reveals the symbol. The list also feeds the breadcrumb.
 */

import { CellView } from "@habemus-papadum/aiui-viz";
import { For, Show } from "solid-js";
import { codeGraph } from "../model/graph";
import { reader } from "../model/store";
import type { OutlineItem } from "../model/types";

/** Monaco/LSP SymbolKind (0-based) → a compact glyph. */
export function kindGlyph(kind: number): string {
  switch (kind) {
    case 4: // Class
      return "🅒";
    case 10: // Interface
      return "🅘";
    case 5: // Method
    case 11: // Function
    case 8: // Constructor
      return "ƒ";
    case 6: // Property
    case 7: // Field
      return "▪";
    case 12: // Variable
    case 13: // Constant
      return "▫";
    case 1: // Module
    case 2: // Namespace
      return "◆";
    default:
      return "·";
  }
}

export function Outline() {
  return (
    <div class="panel outline">
      <div class="panel-header">Outline</div>
      <div class="panel-body">
        <Show when={codeGraph()} fallback={<div class="panel-empty">no graph</div>}>
          {(g) => (
            <Show when={reader.currentFile()} fallback={<div class="panel-empty">open a file</div>}>
              <CellView of={g().outline} label="symbols">
                {(items) => (
                  <Show
                    when={items().length > 0}
                    fallback={<div class="panel-empty">no symbols</div>}
                  >
                    <For each={items()}>{(item) => <OutlineRow item={item} />}</For>
                  </Show>
                )}
              </CellView>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}

function OutlineRow(props: { item: OutlineItem }) {
  return (
    <button
      type="button"
      class="tree-row outline-row"
      style={{ "padding-left": `${8 + props.item.depth * 14}px` }}
      onClick={() => reader.reveal(props.item.selectionRange)}
      title={props.item.detail}
    >
      <span class="tree-icon">{kindGlyph(props.item.kind)}</span>
      <span class="tree-label">{props.item.name}</span>
      <Show when={props.item.detail}>
        <span class="outline-detail">{props.item.detail}</span>
      </Show>
    </button>
  );
}
