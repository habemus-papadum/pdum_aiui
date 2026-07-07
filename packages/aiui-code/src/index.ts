/**
 * @habemus-papadum/aiui-code — the LSP-backed, Monaco-based read-only code
 * reader for the aiui cockpit (the **frontend**).
 *
 * Session-agnostic: {@link mountCodeReader} renders the reader into an element
 * and returns a {@link CodeReaderInstance} (the live model + a disposer). A host
 * — the dev overlay's reader window, or the standalone dev harness — wires that
 * model to the session bus. The backend it talks to lives in
 * `@habemus-papadum/aiui-code-server`; the wire contract is
 * `@habemus-papadum/aiui-code-protocol`.
 */

export type {
  Walkthrough,
  WalkthroughStep,
  WalkthroughSummary,
} from "@habemus-papadum/aiui-code-protocol";
export { AIUI_CODE_PREFIX, ROUTES } from "@habemus-papadum/aiui-code-protocol";
export { backendOrigin, backendUrl, setBackendOrigin } from "./model/backend-origin";
export type { CodeReader } from "./model/reader";
export type { SelectionSnapshot } from "./model/types";
export type { CodeReaderInstance, MountCodeReaderOptions } from "./mount";
export { mountCodeReader } from "./mount";
