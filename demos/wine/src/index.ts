/**
 * index.ts — the app's LIBRARY surface (the `.` export): what a sibling
 * package importing this app gets. The starter exports its scope, graph, and
 * root component; as your real app grows, export its store surface, widgets,
 * and pure model functions here the same way (the in-repo reference demos —
 * morphogen, aztec, seismos, circle in pdum_aiui — model the shape).
 *
 * The mountable page lives behind the `./page` subpath on purpose: importing
 * THIS barrel should not drag in the page's stylesheet or wiring side effects.
 *
 * The `./store` and `./specs` subpaths exist for consumers that mount the
 * dashboard piecemeal under their own look (the FAI pitch deck): they carry
 * the durable plumbing and the themable vgplot specs WITHOUT graph.ts — this
 * barrel imports the graph, whose dataset cell starts the ~64 MB download the
 * moment it builds, and a consumer embedding the atlas behind its own gate
 * must be able to import the store without that side effect.
 */

export { degreesToEqBox, eqBoxToDegrees, equalEarth, equalEarthInverse } from "./model/geo";
export { type AppGraph, graph } from "./model/graph";
export { dimsToRect, rectToDims } from "./model/region";
export { appScope, type Summary, store, type WineDims } from "./model/store";
export { wine } from "./palette";
export { App } from "./ui/App";
export { Embedding } from "./ui/Embedding";
