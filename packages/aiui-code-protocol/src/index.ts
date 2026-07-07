/**
 * @habemus-papadum/aiui-code-protocol — the wire contract shared by the aiui
 * code reader's **frontend** (`@habemus-papadum/aiui-code`) and **backend**
 * (`@habemus-papadum/aiui-code-server`).
 *
 * Everything here is transport-agnostic plumbing with zero runtime dependencies:
 * the HTTP route strings under `/__aiui_code`, the request/response payload
 * shapes they carry, the `/lsp` websocket byte-relay convention, and the
 * walkthrough model. Keeping it in one dependency-free package is what lets the
 * two halves be built, published, and versioned independently while agreeing on
 * the same bytes.
 */

export * from "./protocol";
export * from "./walkthrough";
