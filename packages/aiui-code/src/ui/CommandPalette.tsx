/**
 * CommandPalette.tsx — string navigation, the cheapest high-value power tool.
 * Fuzzy file-open by default; prefix the query with `@` for a project-wide
 * symbol jump (LSP `workspace/symbol`). Arrow keys move, Enter opens, Esc closes.
 */
import { createEffect, createSignal, For, Show } from "solid-js";
import type {
  Range as LspRange,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { codeGraph } from "../model/graph";
import { reader } from "../model/store";
import { kindGlyph } from "./Outline";

interface Item {
  glyph: string;
  label: string;
  detail: string;
  open: () => void;
}

/** Subsequence fuzzy score: matches if `q` is a subsequence of `text`; higher
 * for contiguous / earlier matches. Returns -1 for no match. */
function fuzzyScore(text: string, q: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 2 : 0;
    score += streak + Math.max(0, 6 - (found - ti));
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

export function CommandPalette(props: { open: boolean; seed?: string; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<Item[]>([]);
  const [active, setActive] = createSignal(0);

  let inputEl: HTMLInputElement | undefined;

  // Focus + reset whenever it opens. `seed` lets a caller open straight into
  // symbol mode ("@") vs. file mode ("").
  createEffect(
    () => ({ open: props.open, seed: props.seed }),
    ({ open, seed }) => {
      if (open) {
        setQuery(seed ?? "");
        setActive(0);
        queueMicrotask(() => {
          inputEl?.focus();
          inputEl?.select();
        });
      }
    },
  );

  // Recompute results as the query changes. Files are synchronous (filter the
  // tree); `@symbol` is an async LSP round-trip guarded against stale returns.
  let token = 0;
  createEffect(
    () => ({ q: query(), tree: codeGraph()?.fileTree.latest() ?? [] }),
    ({ q, tree }) => {
      const mine = ++token;
      if (q.startsWith("@")) {
        const sym = q.slice(1);
        void reader.workspaceSymbols(sym).then((results) => {
          if (mine !== token) return;
          setItems(results.slice(0, 100).map(symbolItem).filter(Boolean) as Item[]);
          setActive(0);
        });
        return;
      }
      const files = tree.filter((e) => e.type === "file");
      const scored = files
        .map((e) => ({ e, s: fuzzyScore(e.path, q) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map(({ e }) => ({
          glyph: "·",
          label: e.path.slice(e.path.lastIndexOf("/") + 1),
          detail: e.path,
          open: () => reader.openFile(e.path),
        }));
      setItems(scored);
      setActive(0);
    },
  );

  const choose = (item: Item | undefined) => {
    if (!item) return;
    item.open();
    props.onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items()[active()]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <Show when={props.open}>
      {/* An accessible full-screen button is the backdrop (keyboard-closable);
          the palette is a sibling above it, so a click outside closes and a
          click inside doesn't bubble to it. */}
      <button
        type="button"
        class="palette-backdrop"
        aria-label="Close palette"
        onClick={() => props.onClose()}
      />
      <div class="palette-shell">
        <div class="palette">
          <input
            ref={(el) => {
              inputEl = el;
            }}
            class="palette-input"
            placeholder="Go to file…  (prefix @ for a symbol)"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <div class="palette-list">
            <For each={items()}>
              {(item, i) => (
                <button
                  type="button"
                  class={i() === active() ? "palette-item palette-active" : "palette-item"}
                  onMouseEnter={() => setActive(i())}
                  onClick={() => choose(item)}
                >
                  <span class="tree-icon">{item.glyph}</span>
                  <span class="palette-label">{item.label}</span>
                  <span class="palette-detail">{item.detail}</span>
                </button>
              )}
            </For>
            <Show when={items().length === 0}>
              <div class="palette-empty">no matches</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

function symbolItem(s: SymbolInformation | WorkspaceSymbol): Item | undefined {
  // WorkspaceSymbol.location may be `{ uri }` (needing symbolResolve) or a full
  // Location; SymbolInformation.location is always full. Treat uniformly.
  const loc = ("location" in s ? s.location : undefined) as
    | { uri: string; range?: LspRange }
    | undefined;
  if (!loc?.uri) return undefined;
  return {
    glyph: kindGlyph(s.kind - 1),
    label: s.name,
    detail: "containerName" in s && s.containerName ? String(s.containerName) : "",
    open: () => {
      void reader.openUri(loc.uri, loc.range);
    },
  };
}
