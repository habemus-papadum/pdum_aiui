/**
 * scope.ts — instance identity for composable slices.
 *
 * The reflection registries (controls, actions, cells, edges) are one global
 * namespace per window, and the aiui compiler injects the LEAF name from the
 * declaration binding. That is exactly right for an app compiled as one unit —
 * and silently wrong for a reusable slice instantiated twice: both instances
 * come from the same call site, get the same injected name, and replace-by-name
 * registration cannot tell "second instance" from "HMR re-evaluation" (same
 * name, same loc — no warning fires). The two instances would share one durable
 * state and one registry entry.
 *
 * A **Scope** is the explicit fix: a qualifier the slice factory threads
 * through its declarations —
 *
 * ```ts
 * export function oscillatorStore(s: Scope) {
 *   /** Natural frequency, Hz. *\/
 *   const freq = control({ scope: s, value: 1, min: 0.1, max: 5, step: 0.1 });
 *   const phase = s.durableSignal("phase", 0); // internal state, scoped key
 *   return { freq, phase };
 * }
 * // app store.ts:
 * export const left = oscillatorStore(scope("left"));   // controls "left/freq", …
 * export const right = oscillatorStore(scope("right")); // controls "right/freq", …
 * ```
 *
 * Division of labor, unchanged: the compiler still injects the leaf name, the
 * loc, and the doc-comment description at the call site (one call site → one
 * leaf identity, shared by every instance — which is correct: they ARE the same
 * declaration); the scope is a RUNTIME qualifier that makes each instance's
 * effective identity unique (`left/freq`), flowing into the durable key
 * (`control:left/freq`), the registries, the derived tools (`set` by qualified
 * name; a scoped action's tool is `left/reset`), the dependency edges, and the
 * `data-cell`/`data-control` stamps.
 *
 * Deliberately NOT ambient: there is no context, no "current scope", no owner
 * magic — a slice takes its scope as an argument, the same way it takes its
 * worker or its inputs. Controls are module-level durable declarations; an
 * ambient mechanism would have nothing sound to attach to, and implicitness is
 * exactly what made the double-instantiation failure silent in the first
 * place.
 */
import { durable, durableSignal, type SignalBox } from "./durable";

/** The qualified-name separator ("left/freq"). Durable keys keep their kind
 * prefix around it: `control:left/freq`. */
export const SCOPE_SEPARATOR = "/";

/**
 * An instance qualifier for slice declarations. Create with {@link scope};
 * thread through a slice factory; pass as `{ scope }` on `control`/`action`/
 * `cell` options and use the `durable`/`durableSignal` wrappers for the
 * slice's internal keys.
 */
export interface Scope {
  /** The qualifier itself ("left", or nested "rig/left"). */
  readonly name: string;
  /** Qualified identity for a leaf name: `qualify("freq")` → `"left/freq"`. */
  qualify(leaf: string): string;
  /** A nested scope: `scope("rig").child("left")` ≡ `scope("rig/left")`. */
  child(leaf: string): Scope;
  /** A scope-qualified durable resource (key `"left/history"`). */
  durable<T>(key: string, create: () => T): T;
  /** A scope-qualified durable signal — the slice's internal (non-control) state. */
  durableSignal<T>(
    key: string,
    // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
    initial: Exclude<T, Function>,
  ): SignalBox<T>;
}

function checkSegment(segment: string, what: string): string {
  const trimmed = segment.trim();
  if (trimmed === "") {
    throw new Error(`scope: ${what} must be a non-empty string`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`scope: ${what} "${trimmed}" must not contain whitespace`);
  }
  if (trimmed.startsWith(SCOPE_SEPARATOR) || trimmed.endsWith(SCOPE_SEPARATOR)) {
    throw new Error(`scope: ${what} "${trimmed}" must not start or end with "${SCOPE_SEPARATOR}"`);
  }
  return trimmed;
}

/**
 * Create an instance qualifier. Plain data — calling `scope("left")` twice
 * yields two equivalent handles (the NAME is the identity, exactly like every
 * other name in the reflection layer).
 */
export function scope(name: string): Scope {
  const scopeName = checkSegment(name, "scope name");
  const qualify = (leaf: string): string =>
    `${scopeName}${SCOPE_SEPARATOR}${checkSegment(leaf, "leaf name")}`;
  return {
    name: scopeName,
    qualify,
    child: (leaf) => scope(qualify(leaf)),
    durable: (key, create) => durable(qualify(key), create),
    durableSignal: (key, initial) => durableSignal(qualify(key), initial),
  };
}
