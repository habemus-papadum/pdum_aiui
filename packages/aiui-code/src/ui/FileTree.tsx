/**
 * FileTree.tsx — the project's readable files as a collapsible tree. Built from
 * the flat `fileTree` cell; clicking a file drives `reader.openFile`.
 */

import type { FileEntry } from "@habemus-papadum/aiui-code-protocol";
import { CellView } from "@habemus-papadum/aiui-viz";
import { createSignal, For, Show } from "solid-js";
import { codeGraph } from "../model/graph";
import { reader } from "../model/store";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

function buildTree(entries: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirOf = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const existing = dirOf.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : path.slice(0, slash));
    const node: TreeNode = {
      name: path.slice(slash + 1),
      path,
      type: "dir",
      children: [],
    };
    parent.children.push(node);
    dirOf.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.type === "dir") {
      ensureDir(e.path);
      continue;
    }
    const slash = e.path.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : e.path.slice(0, slash));
    parent.children.push({
      name: e.path.slice(slash + 1),
      path: e.path,
      type: "file",
      children: [],
    });
  }
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function TreeRow(props: { node: TreeNode }) {
  const [open, setOpen] = createSignal(props.node.path.split("/").length <= 2);
  const isCurrent = () => reader.currentFile() === props.node.path;
  return (
    <Show
      when={props.node.type === "dir"}
      fallback={
        <button
          type="button"
          class={isCurrent() ? "tree-row tree-file tree-current" : "tree-row tree-file"}
          onClick={() => reader.openFile(props.node.path)}
          title={props.node.path}
        >
          <span class="tree-icon">{fileIcon(props.node.name)}</span>
          <span class="tree-label">{props.node.name}</span>
        </button>
      }
    >
      <div class="tree-dir">
        <button type="button" class="tree-row tree-dir-row" onClick={() => setOpen(!open())}>
          <span class="tree-caret">{open() ? "▾" : "▸"}</span>
          <span class="tree-label">{props.node.name}</span>
        </button>
        <Show when={open()}>
          <div class="tree-children">
            <For each={props.node.children}>{(child) => <TreeRow node={child} />}</For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

const fileIcon = (name: string): string => {
  if (name.endsWith(".py")) return "🐍";
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "🅃";
  if (name.endsWith(".md")) return "📖";
  if (name.endsWith(".toml") || name.endsWith(".json")) return "⚙";
  if (name.endsWith(".sh")) return "▸";
  return "·";
};

export function FileTree() {
  return (
    <div class="panel file-tree">
      <div class="panel-header">Files</div>
      <div class="panel-body">
        <Show when={codeGraph()} fallback={<div class="panel-empty">no graph</div>}>
          {(g) => (
            <CellView of={g().fileTree} label="listing files">
              {(entries) => (
                <For each={buildTree(entries())}>{(node) => <TreeRow node={node} />}</For>
              )}
            </CellView>
          )}
        </Show>
      </div>
    </div>
  );
}
