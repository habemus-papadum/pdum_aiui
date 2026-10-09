/**
 * source-browser.tsx — the dock's `source` pane: the files this page can
 * read (aiui-viz's source reader — the dev server's workspace, or what a
 * build shipped) as a tree on the left, and the file you pick on the right,
 * syntax-coloured with a number on every line. The same listing and the
 * same text the `sources` and `source` page tools hand an agent, so what a
 * person browses here is what the model reads there.
 */
import {
  listSources,
  type SourceListing,
  SourceUnavailableError,
  sourceText,
} from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  buildSourceTree,
  highlightLines,
  loadHighlighter,
  type SourceTreeNode,
} from "./source-tree";

export interface SourceBrowserProps {
  /** The reader's seams, for a host that is not a page (tests, a preview). */
  deps?: {
    list?: () => Promise<SourceListing>;
    read?: (file: string) => Promise<string>;
    highlighter?: () => ReturnType<typeof loadHighlighter>;
  };
}

function TreeNodes(props: {
  nodes: SourceTreeNode[];
  depth: number;
  current: string | undefined;
  open: (path: string) => void;
}): JSX.Element {
  return (
    <ul class="aiui-src-nodes">
      <For each={props.nodes}>
        {(node) => (
          <li>
            <Show
              when={node.children}
              keyed
              fallback={
                <button
                  type="button"
                  class="aiui-src-file"
                  aria-current={props.current === node.path ? "true" : undefined}
                  onClick={() => {
                    if (node.path !== undefined) props.open(node.path);
                  }}
                >
                  {node.name}
                </button>
              }
            >
              {(children) => (
                <details open={props.depth === 0}>
                  <summary class="aiui-src-dir">{node.name}</summary>
                  <TreeNodes
                    nodes={children}
                    depth={props.depth + 1}
                    current={props.current}
                    open={props.open}
                  />
                </details>
              )}
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

export function SourceBrowser(props: SourceBrowserProps): JSX.Element {
  const list = props.deps?.list ?? listSources;
  const read = props.deps?.read ?? sourceText;
  const highlighter = props.deps?.highlighter ?? loadHighlighter;

  const [listing, setListing] = createSignal<SourceListing | undefined>(undefined);
  const [listError, setListError] = createSignal<string | undefined>(undefined);
  const [file, setFile] = createSignal<string | undefined>(undefined);
  const [lines, setLines] = createSignal<string[] | undefined>(undefined);
  const [fileError, setFileError] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);

  void list().then(setListing, (err: unknown) =>
    setListError(err instanceof Error ? err.message : String(err)),
  );
  const tree = createMemo(() => buildSourceTree(listing()?.files ?? []));

  // Opens are serialised by a token: a slow read must not land over a later pick.
  let opening = 0;
  const open = async (path: string): Promise<void> => {
    const token = ++opening;
    setFile(path);
    setLines(undefined);
    setFileError(undefined);
    setBusy(true);
    try {
      const [text, hljs] = await Promise.all([
        read(path),
        highlighter().catch(() => undefined), // no colour is better than no file
      ]);
      if (token !== opening) return;
      setLines(highlightLines(text, path, hljs));
    } catch (err) {
      if (token !== opening) return;
      setFileError(
        err instanceof SourceUnavailableError
          ? err.reason
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      if (token === opening) setBusy(false);
    }
  };

  return (
    <div class="aiui-src">
      <nav class="aiui-src-tree" aria-label="source files">
        <Show when={listing()} fallback={<p class="aiui-dock-note">{listError() ?? "listing…"}</p>}>
          {(l) => (
            <Show
              when={(l().files?.length ?? 0) > 0}
              fallback={
                <p class="aiui-dock-note">{l().note ?? "this page lists no source files"}</p>
              }
            >
              <p class="aiui-src-mode">
                {l().mode === "dev" ? "dev server" : "shipped build"} · {l().files?.length} files
              </p>
              <TreeNodes nodes={tree()} depth={0} current={file()} open={(p) => void open(p)} />
            </Show>
          )}
        </Show>
      </nav>
      <div class="aiui-src-view">
        <Show when={file()} fallback={<p class="aiui-dock-note">pick a file</p>}>
          {(f) => (
            <>
              <div class="aiui-src-head">
                <code class="aiui-src-path">{f()}</code>
                <Show when={lines()}>
                  {(l) => <span class="aiui-src-count">{l().length} lines</span>}
                </Show>
                <Show when={busy()}>
                  <span class="aiui-src-count">reading…</span>
                </Show>
              </div>
              <Show when={fileError()}>{(e) => <p class="aiui-dock-note">{e()}</p>}</Show>
              <Show when={lines()}>
                {(l) => (
                  <pre class="aiui-src-code">
                    <For each={l()}>
                      {(html, i) => (
                        <div class="aiui-src-line">
                          <span class="aiui-src-n">{i() + 1}</span>
                          <span class="aiui-src-text" innerHTML={html} />
                        </div>
                      )}
                    </For>
                  </pre>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
