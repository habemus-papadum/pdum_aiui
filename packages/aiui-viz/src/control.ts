/**
 * control.ts — the control surface: the app's writable frontier, reified.
 *
 * A **control** is a curated, annotated durable signal — an independent
 * variable the user moves through widgets and an agent moves through derived
 * tools. An **action** is a registered verb (capture, re-seed) — an operation
 * that isn't a value. Together with the cell registry (the derived interior)
 * and the dependency edges (graph-trace.ts), they form the reflection layer an
 * agent reads instead of spelunking source — while `loc` on every entry still
 * points at the code when it wants to dig.
 *
 * The division of labor (ratified; docs/proposals/front_end_controls_guide_and_more.md):
 * compile time owns LOCATIONS (the aiui compiler injects `name` from the
 * binding, `loc`, and `description` from the doc comment), declarations own
 * IDENTITY, runtime owns LIVE STATE AND TOPOLOGY. Two consequences here:
 *
 *  - `control({ value })` reaching runtime with no name **throws loudly** —
 *    the name is the durable-persistence key and the agent-tool identity, and
 *    a silently anonymous control would corrupt both. (The compiler makes
 *    this unreachable in a configured app; the error names the fix.)
 *  - Validation lives HERE, once: `set` clamps ranges, snaps to `step`,
 *    checks enum membership and value type — so the slider, the keyboard
 *    binding, and the agent's `set` tool cannot disagree about what a legal
 *    value is.
 *
 * Registration is replace-by-name (the agentToolkit convention), which is what
 * makes hot re-evaluation of a declaring module safe; a replacement whose
 * definition site DIFFERS from the original logs a console warning, because
 * that is the signature of a genuine cross-module name collision rather than
 * an HMR swap. Controls are durable by construction (`durable` registry, key
 * `control:<name>`): a hot edit never resets what the user set — and renaming
 * a control's binding therefore *is* a state reset, with the pedantic
 * `{ name: "…" }` form as the documented escape hatch.
 */
import type { Setter } from "solid-js";
import { durableSignal, type SignalBox } from "./durable";
import { recordRead } from "./graph-trace";
import type { Scope } from "./scope";

/** Constraint / presentation metadata for a control's value. */
export interface ControlMeta<T> {
  /** Inclusive lower bound (numbers). Out-of-range writes are CLAMPED. */
  min?: number;
  /** Inclusive upper bound (numbers). Out-of-range writes are CLAMPED. */
  max?: number;
  /** Snap increment (numbers), anchored at `min` (else 0). */
  step?: number;
  /** Display unit ("eV", "ms") — presentation only. */
  unit?: string;
  /** Legal values (enums). A write outside the set THROWS. */
  options?: readonly T[];
}

/** The single-options-object form the aiui compiler completes. */
export interface ControlSpec<T> extends ControlMeta<T> {
  /**
   * Identity: durable key + tool name + grep target. Injected by the compiler
   * from the assignment binding (`export const kappa = control(…)` → "kappa");
   * write it explicitly to rename a binding WITHOUT resetting durable state.
   */
  name?: string;
  /**
   * Instance qualifier for slice factories (see scope.ts): the effective
   * identity becomes `<scope>/<name>`, so a slice instantiated twice gets two
   * controls with two durable states instead of silently sharing one. The
   * compiler still injects the LEAF name; the scope is runtime data.
   */
  scope?: Scope;
  /** Initial value (the durable registry adopts an existing one on hot edits). */
  value: T;
  /** Human description — compiler-lifted from the doc comment, or explicit. */
  description?: string;
  /** Definition site "file:line" — compiler-injected. */
  loc?: string;
}

/** A live control: the two-way box plus its identity and metadata. */
export interface ControlBox<T> extends SignalBox<T> {
  /** The effective identity — scope-qualified when declared with one. */
  readonly name: string;
  /** The declaring scope's name, when scoped ("left" of "left/freq"). */
  readonly scope?: string;
  readonly description?: string;
  readonly loc?: string;
  readonly meta: ControlMeta<T>;
  /** The declared initial value (reset affordances; test resets). */
  readonly initial: T;
}

/** An action: a registered verb the app exposes. */
export interface ActionSpec {
  /** Identity — same rules as a control's name. */
  name?: string;
  /** Instance qualifier (see {@link ControlSpec.scope}): the registered name —
   * and so the derived agent tool — becomes `<scope>/<name>`. */
  scope?: Scope;
  /** Human description — compiler-lifted from the doc comment, or explicit. */
  description?: string;
  /** Definition site "file:line" — compiler-injected. */
  loc?: string;
  /** Human/agent-readable parameter docs (WebMCP-style loose schema). */
  params?: Record<string, string>;
  /** Real JSON Schema for the arguments, when the loose form isn't enough. */
  inputSchema?: Record<string, unknown>;
  /** The implementation. */
  run: (args?: Record<string, unknown>) => unknown;
}

/** One registered action (spec with identity resolved; `scope` as its name). */
export interface RegisteredAction extends Omit<ActionSpec, "name" | "scope"> {
  name: string;
  scope?: string;
}

/** A snapshot entry of the control surface (see {@link controlSurface}). */
export type ControlSurfaceEntry =
  | {
      kind: "control";
      name: string;
      scope?: string;
      value: unknown;
      description?: string;
      loc?: string;
      meta: ControlMeta<unknown>;
    }
  | {
      kind: "action";
      name: string;
      scope?: string;
      description?: string;
      loc?: string;
      params?: Record<string, string>;
    };

const controls = new Map<string, ControlBox<unknown>>();
const actions = new Map<string, RegisteredAction>();
const listeners = new Set<() => void>();

function notifySurfaceChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber (a tools bridge mid-teardown) must never break
      // control declaration.
    }
  }
}

/**
 * Subscribe to control-surface changes (a control or action registered).
 * Used by the standard tools to register late-declared actions as agent
 * tools. Returns an unsubscribe.
 */
export function subscribeControlSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const MISSING_NAME =
  "needs a name — either the aiui compiler plugin (aiuiDevOverlay({ locator: true }), which " +
  'infers it from the assignment binding) or an explicit { name: "…" }. The name is the ' +
  "durable key and the agent-tool identity; it cannot be anonymous.";

function requireName(kind: "control" | "action", name: string | undefined): string {
  if (!name) {
    throw new Error(`${kind}() ${MISSING_NAME}`);
  }
  return name;
}

function warnOnCollision(
  kind: "control" | "action",
  name: string,
  existingLoc: string | undefined,
  incomingLoc: string | undefined,
): void {
  // Same loc (or unknowable) is the HMR-re-evaluation shape; a DIFFERENT
  // definition site is the signature of two declarations fighting for a name.
  if (existingLoc !== undefined && incomingLoc !== undefined && existingLoc !== incomingLoc) {
    console.warn(
      `aiui: ${kind} "${name}" re-registered from ${incomingLoc} (was ${existingLoc}) — ` +
        "two declarations share a name; the later one wins.",
    );
  }
}

/**
 * Declare one control. Returns the two-way box widgets bind and cells read —
 * reads are recorded as dependency edges when they happen inside a cell's
 * deps; writes are validated against the meta in ONE place:
 *
 *  - wrong type (vs. the initial value's type) → throws;
 *  - outside `options` (when given) → throws;
 *  - outside `min`/`max` → clamped; off-`step` → snapped.
 *
 * ```ts
 * /** Diffusion constant — how fast heat spreads. *\/
 * export const kappa = control({ value: 0.1, min: 0.01, max: 1, step: 0.01 });
 * kappa.get();     // read (edge-recorded inside cell deps)
 * kappa.set(2);    // → clamped to 1
 * ```
 */
export function control<T>(spec: ControlSpec<T>): ControlBox<T> {
  const leaf = requireName("control", spec.name);
  // The effective identity: scope-qualified when the declaration came from a
  // slice factory. Everything downstream — durable key, registry, tools,
  // edges, stamps — sees only the qualified name.
  const name = spec.scope !== undefined ? spec.scope.qualify(leaf) : leaf;
  const meta: ControlMeta<T> = {
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    ...(spec.step !== undefined ? { step: spec.step } : {}),
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
  };
  const valueType = typeof spec.value;

  // Durable by construction: the box survives hot edits; `control:` namespaces
  // the key away from hand-rolled durableSignal keys.
  const box = durableSignal<T>(
    `control:${name}`,
    // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
    spec.value as Exclude<T, Function>,
  );

  const validate = (next: T): T => {
    if (meta.options !== undefined) {
      if (!meta.options.includes(next)) {
        const legal = meta.options.map((o) => JSON.stringify(o)).join(", ");
        throw new Error(`control "${name}": value ${JSON.stringify(next)} is not one of ${legal}`);
      }
      return next;
    }
    if (typeof next !== valueType) {
      throw new Error(
        `control "${name}": expected ${valueType}, got ${typeof next} (${JSON.stringify(next)})`,
      );
    }
    if (valueType === "number") {
      let n = next as number;
      if (!Number.isFinite(n)) {
        throw new Error(`control "${name}": value must be a finite number`);
      }
      if (meta.step !== undefined && meta.step > 0) {
        const anchor = meta.min ?? 0;
        n = anchor + Math.round((n - anchor) / meta.step) * meta.step;
        // Snap arithmetic breeds 0.30000000000000004; round to the step's
        // precision so the registry shows the number the user meant.
        const decimals = (String(meta.step).split(".")[1] ?? "").length;
        n = Number(n.toFixed(decimals));
      }
      if (meta.min !== undefined) n = Math.max(meta.min, n);
      if (meta.max !== undefined) n = Math.min(meta.max, n);
      return n as T;
    }
    return next;
  };

  const set = ((next: T | ((prev: T) => T)) => {
    if (typeof next === "function") {
      // Resolve the updater THROUGH Solid's setter, never against box.get():
      // writes are staged until the next microtask, so a same-tick chain of
      // updaters must compose against the pending value (Solid resolves it) —
      // resolving against the committed read silently drops every update but
      // the last (two set(v=>v+1) in one tick yielded 1, measured).
      let valid!: T;
      box.set(((prev: T) => {
        valid = validate((next as (prev: T) => T)(prev));
        // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
        return valid as Exclude<T, Function>;
      }) as never);
      return valid;
    }
    const valid = validate(next as T);
    // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
    box.set(valid as Exclude<T, Function>);
    return valid;
  }) as Setter<T>;

  const entry: ControlBox<T> = {
    get: () => {
      recordRead({ kind: "control", name }); // consumer-aware no-op otherwise
      return box.get();
    },
    set,
    name,
    ...(spec.scope !== undefined ? { scope: spec.scope.name } : {}),
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.loc !== undefined ? { loc: spec.loc } : {}),
    meta,
    initial: spec.value,
  };

  warnOnCollision("control", name, controls.get(name)?.loc, spec.loc);
  controls.set(name, entry as ControlBox<unknown>);
  notifySurfaceChanged();
  return entry;
}

/**
 * Declare one action — the verb form of the surface. It becomes a real,
 * named, described agent tool the moment `registerStandardTools` is active
 * (declared before or after; the surface subscription covers both orders).
 */
export function action(spec: ActionSpec): RegisteredAction {
  const leaf = requireName("action", spec.name);
  const name = spec.scope !== undefined ? spec.scope.qualify(leaf) : leaf;
  const { scope: specScope, ...rest } = spec;
  const entry: RegisteredAction = {
    ...rest,
    name,
    ...(specScope !== undefined ? { scope: specScope.name } : {}),
  };
  warnOnCollision("action", name, actions.get(name)?.loc, spec.loc);
  actions.set(name, entry);
  notifySurfaceChanged();
  return entry;
}

/** Look up a live control by name. */
export function controlByName(name: string): ControlBox<unknown> | undefined {
  return controls.get(name);
}

/** Look up a registered action by name. */
export function actionByName(name: string): RegisteredAction | undefined {
  return actions.get(name);
}

/**
 * Snapshot of the whole control surface — every control (with its current
 * value) and every action. The agent-facing view of "what can be moved".
 */
export function controlSurface(): ControlSurfaceEntry[] {
  const out: ControlSurfaceEntry[] = [];
  for (const c of controls.values()) {
    out.push({
      kind: "control",
      name: c.name,
      ...(c.scope !== undefined ? { scope: c.scope } : {}),
      value: c.get(),
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.loc !== undefined ? { loc: c.loc } : {}),
      meta: c.meta,
    });
  }
  for (const a of actions.values()) {
    out.push({
      kind: "action",
      name: a.name,
      ...(a.scope !== undefined ? { scope: a.scope } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.loc !== undefined ? { loc: a.loc } : {}),
      ...(a.params !== undefined ? { params: a.params } : {}),
    });
  }
  return out;
}

/**
 * Restore every registered control to its declared initial value (through its
 * own validation). The registrations themselves persist — module-declared
 * controls exist exactly once per page, and a test-time "reset" must mirror
 * that reality (the template e2e caught the alternative: unregistering left
 * the SECOND test in a file staring at an empty registry, because modules
 * don't re-import). Exposed to apps via `resetControlSurface` in
 * `@habemus-papadum/aiui-viz/testing`.
 */
export function restoreControlDefaults(): void {
  for (const c of controls.values()) {
    c.set(c.initial as never);
  }
}

/**
 * @internal Hard clear for library-internal tests that declare fresh controls
 * per case. App tests want `resetControlSurface` (values-only) instead.
 */
export function clearControlSurface(): { durableKeys: string[] } {
  const durableKeys = [...controls.keys()].map((name) => `control:${name}`);
  controls.clear();
  actions.clear();
  notifySurfaceChanged();
  return { durableKeys };
}
