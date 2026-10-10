export { Fragment, type JSX } from "./jsx-runtime.ts";

import { jsx } from "./jsx-runtime.ts";
import type { Node } from "./model.ts";

/** Dev-tool supplied locations are deliberately ignored: no source transform is implemented. */
export function jsxDEV<P>(
  component: (props: P) => Node,
  props: P,
  key?: string,
  _staticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): Node {
  return jsx(component, props, key);
}
