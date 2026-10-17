/**
 * index.ts — the catalog demo's library surface: its scope, graph and root
 * component (the shape every demo exports), plus the catalog parser, which
 * another page could use to render the same file.
 */
export {
  allPieceRows,
  type Block,
  type CatalogDoc,
  type PieceRow,
  parseCatalog,
  pieceRows,
  rewriteLinks,
} from "./model/catalog";
export { type AppGraph, graph } from "./model/graph";
export { SECTION_SPECIMEN_IDS, SPECIMEN_KEYS } from "./model/specimen-keys";
export { appScope } from "./model/store";
export { App } from "./ui/App";
