import { Group, type Node } from "./model.ts";

export const Fragment = Group;
export function jsx<P>(component: (props: P) => Node, props: P, _key?: string): Node {
  if (typeof component !== "function") throw new TypeError("Only prompt components are supported.");
  return component(props);
}
export const jsxs = jsx;

// TS requires this namespace to describe the automatic JSX runtime.
export namespace JSX {
  export type Element = Node;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  // No intrinsic DOM tags: a <div> cannot accidentally become prompt content.
  export type IntrinsicElements = Record<never, never>;
}
