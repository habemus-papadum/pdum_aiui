/**
 * @habemus-papadum/create-aiui — the `pnpm create @habemus-papadum/aiui`
 * scaffolder. The bin lives in cli.ts; this library surface exposes the
 * scaffolding primitives for tests and for anything that wants to drive a
 * scaffold programmatically.
 */
export {
  appNameFrom,
  classifyTarget,
  dependencyRange,
  initGitRepo,
  packageManager,
  scaffoldApp,
  type TargetState,
  templateRoot,
} from "./scaffold";
export { VERSION } from "./version";
