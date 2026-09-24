/**
 * index.ts — the lab's LIBRARY surface: its scope, graph, root component, and
 * the pure catalog model (the naming rules a sibling MotherDuck app can reuse).
 */
export * from "./model/catalog";
export { type AppGraph, graph } from "./model/graph";
export { appScope, BROKER_KEY, store } from "./model/store";
export { App } from "./ui/App";
