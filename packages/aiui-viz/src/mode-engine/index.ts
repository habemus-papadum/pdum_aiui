/**
 * `@habemus-papadum/aiui-viz/mode-engine` — the mode engine: regions, a pure
 * command reducer as the only writer, and claims for the async operations
 * the settings imply. The design note (the contract, what was retired and
 * why, what to consider when those needs return) is docs/mode-engine.md.
 *
 * - `createModeEngine` (engine.ts) — regions (`ladder` / `toggle` / `choice`
 *   / `openChoice`), commands, excludes, mechanical esc/blur, the commit
 *   path with its queue.
 * - `createClaims` (claims.ts) — desired operations derived from (state,
 *   context), reconciled after every commit, with per-claim status and
 *   supersession that aborts the in-flight acquire.
 * - `guardedEffect` (effect.ts) — one async effect under completion-time
 *   revalidation, an outer abort signal, and a ceiling.
 *
 * Consumer: the aiui-audio hub (one engine, one claim). Realm rules: no Solid
 * import, no DOM — the engine runs in node, workers and tests as plain data
 * + functions; a host mirrors state into its own reactive system.
 */

export {
  type ClaimPhase,
  type ClaimSpec,
  type ClaimSpecs,
  type ClaimStatus,
  type ClaimsHandle,
  type ClaimsOptions,
  createClaims,
} from "./claims";
export { type GuardedOutcome, type GuardOptions, guardedEffect } from "./effect";
export {
  type ChoiceRegion,
  type CommandFn,
  choice,
  createModeEngine,
  type DispatchEvent,
  type EngineEvent,
  type EngineState,
  type EventBinding,
  type ExcludeRule,
  type LadderRegion,
  ladder,
  type ModeEngine,
  type ModeEngineOptions,
  type ModeEngineSpec,
  type OpenChoiceRegion,
  openChoice,
  type RegionSpec,
  type RegionValue,
  type StatePatch,
  type ToggleRegion,
  toggle,
} from "./engine";
