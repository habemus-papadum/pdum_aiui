/**
 * index.ts — the demo's library surface: the scope, the graph, the root
 * component, and the shared prompt/tool modules the headless script uses.
 */
export { APP_BLURB, BACKENDS_SLOTS, LIVE_SLOTS, WIRE_SLOTS } from "./live/prompt";
export { benchTools } from "./live/tools";
export { type AppGraph, graph } from "./model/graph";
export { appScope, osc, samples } from "./model/store";
export { App } from "./ui/App";
