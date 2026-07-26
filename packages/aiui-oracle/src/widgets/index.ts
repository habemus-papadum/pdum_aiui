/** The opt-in Solid widgets — kept behind their own subpath so the chromeless
 * core (`.`) stays framework-light for non-Solid hosts. */
export type { OracleControlProps } from "./control";
export { OracleControl, useOracleState } from "./control";
export type { OracleKeyProps } from "./key";
export { OracleKey } from "./key";
export type { OracleViewerProps } from "./viewer";
export { OracleMind, OracleViewer } from "./viewer";
export type { LedgerCategory, TurnGroup } from "./viewer-model";
export {
  ALL_CATEGORIES,
  activityLine,
  categoryOf,
  defaultCategories,
  entryDetail,
  entryLine,
  groupTurns,
  summarizeTurn,
} from "./viewer-model";
