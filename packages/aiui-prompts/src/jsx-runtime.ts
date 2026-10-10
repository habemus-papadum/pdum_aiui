import { copyJson, freeze } from "./json.ts";
import { Group, type Origin, PromptError, type PromptValue, Use } from "./model.ts";
export const Fragment = Group;
/** The source transform supplies origin on this reserved prop; it is stripped before user code. */
export function jsx<P>(
  component: (props: P) => PromptValue,
  props: P & { __promptOrigin?: Origin; key?: string | number },
  key?: string | number,
): PromptValue {
  if (typeof component !== "function")
    throw new PromptError(
      "JSX_DIALECT",
      "Only prompt components are supported; intrinsic DOM elements are not prompt nodes.",
    );
  const { __promptOrigin, key: spreadKey, ...componentProps } = props ?? {};
  const placementKey = spreadKey !== undefined ? spreadKey : key;
  const result = component(componentProps as P);
  Group({ children: result }); // Validate without adding a semantic boundary.
  const value = placementKey !== undefined ? Use({ value: result, key: placementKey }) : result;
  return __promptOrigin !== undefined ? withPromptOrigin(value, __promptOrigin) : value;
}
/** Capture placement lineage without changing array flattening, join separators, or item budgets. */
export function withPromptOrigin(value: PromptValue, origin: Origin): PromptValue {
  const captured = freeze(copyJson(origin));
  function attach(input: PromptValue): PromptValue {
    if (input === null || input === false) return input;
    if (Array.isArray(input)) return Object.freeze(input.map(attach));
    return Use({ value: input, origin: captured });
  }
  Group({ children: value });
  return attach(value);
}
export const jsxs = jsx;
/** Fallback emitted for a key after a JSX spread: argument evaluation stays with the JS compiler. */
export function createElement<P>(
  component: (props: P) => PromptValue,
  props: (P & { __promptOrigin?: Origin; key?: string | number }) | null,
  ...children: PromptValue[]
): PromptValue {
  const input = {
    ...props,
    ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
  };
  return jsx(component, input as P & { __promptOrigin?: Origin; key?: string | number });
}
export namespace JSX {
  export type Element = PromptValue;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    key?: string | number;
    __promptOrigin?: Origin;
  }
  export type IntrinsicElements = Record<never, never>;
}
