/**
 * engine.ts — the mode engine: the composition layer the kit's modules were
 * waiting for (docs/proposals/intent-client/01-mode-engine.md).
 *
 * The kit has vocabulary — ladder columns (mode.ts), key layers (keys.ts),
 * per-event reconciliation (reconcile.ts), guarded effects (effect.ts) — but
 * no grammar: each app hand-rolled the composition, and the composition is
 * where the two intent clients' ~25-incident bug ledger lived. The engine is
 * that grammar, built on one clarifying split:
 *
 * > Every "mode" is two things: a **setting** (what the user chose —
 * > standing, often durable, often agent-visible) and an **operation** (what
 * > the world is doing about it right now — derived, transient, async).
 *
 * Settings live in **regions** — named, independently-valued axes (the state
 * is their product, so orthogonality is by construction and exclusion inside
 * a region is free). Operations are **claims** (./claims.ts) — pure
 * derivations from (regions, context) that a reconciler drives; their status
 * is the "neither on nor off" state, derived and displayable, never stored.
 *
 * **Commands are the only writers.** Keyboard resolver output, cap clicks,
 * agent control.set, system events (via bindings), tests — all funnel into
 * `dispatch(command, payload)`, a pure reducer `(state, command, ctx) →
 * state'` plus declared cross-region `excludes`, applied once, in
 * declaration order — no fixpoint, no constraint solver. Esc and blur are
 * commands too, resolved mechanically from spec columns (the §13.6 ladder as
 * a list). When nothing but the reducer writes machine state, "write then
 * read back" has no call sites left to occur at — the engine is the
 * structural fix for that bug class, and the write-semantics proposal's M2
 * given one home: the runtime commits atomically (the host installs a
 * `commit` hook — the Solid adapter passes `flush`), so by the time
 * `dispatch` returns, every derived value and effect-driven projection is
 * current.
 *
 * Deliberately NOT here (01 §4): entry/exit effects (the ledger is
 * unambiguous — per-event reconciliation beats transition bookkeeping, so
 * effects are claims), history states, actor spawning, XState (our chart
 * semantics are small; the value is the integrations, bespoke either way).
 *
 * Realm rules (like the rest of modal/): no Solid import, no DOM at module
 * scope — the engine core runs in node, workers, and tests as plain data +
 * functions. The Solid adapter lives in the package root (`solidModeEngine`).
 */

/** A region's value: ladders and choices are strings, toggles are booleans. */
export type RegionValue = string | boolean;

/** The engine's state: the product of the regions. Immutable — patch by dispatch. */
export type EngineState = Readonly<Record<string, RegionValue>>;

/** A patch a command returns: region name → new value. */
export type StatePatch = Readonly<Record<string, RegionValue>>;

interface RegionCommon {
  /**
   * Survives reload (standing settings). The core only carries the flag; the
   * host adapter decides the storage (the Solid adapter adopts a durable
   * registry entry / the agent control's persisted value as the initial).
   */
  durable?: boolean;
  /**
   * Expose on the agent control surface under this name: the control's
   * getter reads the region, its setter dispatches `set:<region>` — the
   * engine stays the single writer, so an agent's `set` and the key take the
   * identical path (this is what structurally kills control-mirror desyncs).
   */
  agent?: string;
  /** Human description, carried to the agent control when `agent` is set. */
  description?: string;
}

/**
 * An exclusive, ordered axis; Esc walks it downward one rung per press.
 * `disarmed ⊂ armed ⊂ turn ⊂ turn.tweak`, as data.
 */
export interface LadderRegion extends RegionCommon {
  kind: "ladder";
  rungs: readonly string[];
  /** Initial rung; defaults to the first. */
  initial: string;
  /**
   * Esc never steps below this rung: `escFloor: "armed"` makes Esc cancel a
   * turn but never disarm (disarm is its own deliberate command). Defaults
   * to the first rung (Esc can walk the whole ladder).
   */
  escFloor: string;
  /**
   * Rungs from which a window blur steps out one level — for rungs whose
   * purpose is a round-trip out of the page (a jump-to-editor mode), where
   * coming back must not resume the mode. Blur is Esc's page-focus sibling:
   * one level, never a jump to root.
   */
  blurExitsFrom: readonly string[];
}

/** A boolean standing flag (ink on, help open). */
export interface ToggleRegion extends RegionCommon {
  kind: "toggle";
  initial: boolean;
  /** Window blur turns it off (transient popups, pending leader keys). */
  blurExits?: boolean;
}

/** One choice among several (talk: off | dictation | handsFree | realtime). */
export interface ChoiceRegion extends RegionCommon {
  kind: "choice";
  values: readonly string[];
  /** Initial value; also what Esc/blur restore. Defaults to the first. */
  initial: string;
  /** Window blur restores the initial value. */
  blurExits?: boolean;
}

export type RegionSpec = LadderRegion | ToggleRegion | ChoiceRegion;

/** Declare a ladder region. */
export function ladder(
  rungs: readonly string[],
  opts: Partial<Omit<LadderRegion, "kind" | "rungs">> = {},
): LadderRegion {
  if (rungs.length === 0) {
    throw new Error("ladder(): needs at least one rung");
  }
  return {
    kind: "ladder",
    rungs,
    initial: opts.initial ?? rungs[0],
    escFloor: opts.escFloor ?? rungs[0],
    blurExitsFrom: opts.blurExitsFrom ?? [],
    ...(opts.durable !== undefined ? { durable: opts.durable } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };
}

/** Declare a toggle region. */
export function toggle(opts: Partial<Omit<ToggleRegion, "kind">> = {}): ToggleRegion {
  return {
    kind: "toggle",
    initial: opts.initial ?? false,
    ...(opts.blurExits !== undefined ? { blurExits: opts.blurExits } : {}),
    ...(opts.durable !== undefined ? { durable: opts.durable } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };
}

/** Declare a choice region. */
export function choice(
  values: readonly string[],
  opts: Partial<Omit<ChoiceRegion, "kind" | "values">> = {},
): ChoiceRegion {
  if (values.length === 0) {
    throw new Error("choice(): needs at least one value");
  }
  return {
    kind: "choice",
    values,
    initial: opts.initial ?? values[0],
    ...(opts.blurExits !== undefined ? { blurExits: opts.blurExits } : {}),
    ...(opts.durable !== undefined ? { durable: opts.durable } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };
}

/**
 * A command's reduction: `(state, payload, ctx) → patch`. Pure — reads the
 * frozen pre-state, returns the regions it moves (or null/undefined for a
 * deliberate no-op). It never mutates, never performs effects (effects are
 * claims), and never needs to read back a write: the patch IS the write.
 */
export type CommandFn<Ctx> = (
  state: EngineState,
  payload: unknown,
  ctx: Ctx,
) => StatePatch | null | undefined;

/**
 * A cross-region implication, applied after every command in declaration
 * order, once (no fixpoint): "entering realtime forces the linter off" is
 * `{ when: s => s.talk === "realtime", set: { linter: "off" } }`. Standing
 * abandonment ("disarm turns everything off") is NOT an exclude — it is what
 * the disarm command's reduction does. Excludes are for invariants that must
 * hold no matter which command moved the state.
 */
export interface ExcludeRule {
  /** Human name — shows in traces and property-test failures. */
  name: string;
  when: (state: EngineState) => boolean;
  set: StatePatch;
}

/** A system-event binding: `on: { turnClosed: "phaseArmed" }`. */
export type EventBinding = string | { command: string; payload?: unknown };

export interface ModeEngineSpec<Ctx> {
  regions: Readonly<Record<string, RegionSpec>>;
  commands: Readonly<Record<string, CommandFn<Ctx>>>;
  /**
   * Region names ranked for Esc: per press, the highest-ranked region not at
   * its base steps out ONE level (toggle → off, choice → initial, ladder →
   * one rung down, stopping at its escFloor). Esc is never destructive
   * beyond that one scope; a press with everything at base is a no-op the
   * host may pass to the page.
   */
  escOrder?: readonly string[];
  excludes?: readonly ExcludeRule[];
  /** System events → commands (engine turnClosed, socket drop, tab close). */
  on?: Readonly<Record<string, EventBinding>>;
  /**
   * Availability overrides. Most commands need none — availability is DERIVED
   * by dry-running the pure reducer ("would it change anything here?"). Verbs
   * (pure effects that move no region) derive to "never", so they declare their
   * gate here; a command whose availability differs from its reduction (an arm
   * gate on a context fact) can override too. Keys must name declared commands.
   *
   * This is a GATE, not a hint: an unavailable command is refused by
   * {@link ModeEngine.dispatch} itself, not merely greyed out in the bar. The
   * difference is the whole point — a bar button, a key, an agent's `control()`
   * write and a recovered turn all arrive as the same dispatch, and a rule that
   * only the bar enforces is a rule that holds until the first other caller.
   */
  available?: Readonly<Record<string, (state: EngineState, ctx: Ctx) => boolean>>;
}

/** One dispatch, as trace data (mode changes SHOULD be events — mode.ts). */
export interface DispatchEvent {
  kind: "dispatch";
  command: string;
  payload: unknown;
  before: EngineState;
  after: EngineState;
  /** The regions this dispatch actually moved (post-excludes). */
  changed: readonly string[];
}

export interface ContextEvent {
  kind: "context";
}

export type EngineEvent = DispatchEvent | ContextEvent;

export interface ModeEngineOptions<Ctx> {
  /** The world's initial facts. */
  context: Ctx;
  /**
   * Region overrides adopted at creation (durable recovery: the adapter
   * passes persisted values). Validated like any patch.
   */
  initial?: StatePatch;
  /**
   * The atomic-commit hook: subscribers are notified inside it. The Solid
   * adapter passes `flush`, so effects and memos are current when dispatch
   * returns; the default is a plain call (tests, non-Solid hosts).
   */
  commit?: (apply: () => void) => void;
  /** Trace sink — every dispatch, including no-ops resolved to nothing. */
  onDispatch?: (event: DispatchEvent) => void;
}

export interface ModeEngine<Ctx> {
  /** The committed state — a frozen plain object; reads are never stale. */
  state(): EngineState;
  /** The current context (world facts — inputs, not choices; see setContext). */
  context(): Ctx;
  /**
   * Run one command through the reducer and commit. Returns the new state.
   * Unknown command → throws (loudly; commands are code, not user input).
   * A dispatch from inside a subscriber is queued and runs after the current
   * commit completes (single-writer linearity; it returns the pre-state).
   */
  dispatch(command: string, payload?: unknown): EngineState;
  /**
   * Would dispatching this command do anything right now? Derived by
   * dry-running the pure reducer against the committed state (a returned
   * patch that changes nothing → false); `spec.available` overrides for
   * verbs and gated commands; escape/blur resolve their own steps. The bar
   * projection disables caps from this — gating is mechanical, not
   * hand-written per surface. Unknown command → throws, like dispatch.
   */
  canDispatch(command: string, payload?: unknown): boolean;
  /** Fire a declared system-event binding; unbound events are ignored. */
  emit(event: string, payload?: unknown): EngineState;
  /**
   * Replace world facts (tab identity, grants, connection, selection).
   * Facts are not choices: no command sets them, they are never durable —
   * but claims derive from them, so subscribers are notified.
   */
  setContext(patch: Partial<Ctx>): void;
  /** Notified after every commit (dispatch that changed state, or context). */
  subscribe(listener: (state: EngineState, event: EngineEvent) => void): () => void;
  /** The spec (frozen) — projections read it. */
  readonly spec: ModeEngineSpec<Ctx>;
}

function validateValue(name: string, region: RegionSpec, value: RegionValue): void {
  if (region.kind === "toggle") {
    if (typeof value !== "boolean") {
      throw new Error(`mode engine: region "${name}" is a toggle; got ${JSON.stringify(value)}`);
    }
    return;
  }
  const legal: readonly string[] = region.kind === "ladder" ? region.rungs : region.values;
  if (typeof value !== "string" || !legal.includes(value)) {
    throw new Error(
      `mode engine: region "${name}" allows ${legal.map((v) => JSON.stringify(v)).join(" | ")}; ` +
        `got ${JSON.stringify(value)}`,
    );
  }
}

/** Esc's one-level step-out for a region, or null when it is at base. */
function escStep(region: RegionSpec, value: RegionValue): RegionValue | null {
  if (region.kind === "toggle") {
    return value === true ? false : null;
  }
  if (region.kind === "choice") {
    return value !== region.initial ? region.initial : null;
  }
  const index = region.rungs.indexOf(value as string);
  const floor = region.rungs.indexOf(region.escFloor);
  return index > floor ? region.rungs[index - 1] : null;
}

/** Blur's step for a region, or null when blur means nothing here. */
function blurStep(region: RegionSpec, value: RegionValue): RegionValue | null {
  if (region.kind === "toggle") {
    return region.blurExits === true && value === true ? false : null;
  }
  if (region.kind === "choice") {
    return region.blurExits === true && value !== region.initial ? region.initial : null;
  }
  if (!region.blurExitsFrom.includes(value as string)) {
    return null;
  }
  const index = region.rungs.indexOf(value as string);
  return index > 0 ? region.rungs[index - 1] : null;
}

export function createModeEngine<Ctx>(
  spec: ModeEngineSpec<Ctx>,
  options: ModeEngineOptions<Ctx>,
): ModeEngine<Ctx> {
  // ── spec validation, once, loudly ─────────────────────────────────────────
  for (const [name, region] of Object.entries(spec.regions)) {
    validateValue(name, region, region.initial);
    if (region.kind === "ladder") {
      if (!region.rungs.includes(region.escFloor)) {
        throw new Error(`mode engine: region "${name}" escFloor is not a rung`);
      }
      for (const rung of region.blurExitsFrom) {
        if (!region.rungs.includes(rung)) {
          throw new Error(`mode engine: region "${name}" blurExitsFrom "${rung}" is not a rung`);
        }
      }
    }
  }
  for (const name of spec.escOrder ?? []) {
    if (spec.regions[name] === undefined) {
      throw new Error(`mode engine: escOrder names unknown region "${name}"`);
    }
  }
  for (const rule of spec.excludes ?? []) {
    for (const [name, value] of Object.entries(rule.set)) {
      const region = spec.regions[name];
      if (region === undefined) {
        throw new Error(`mode engine: exclude "${rule.name}" sets unknown region "${name}"`);
      }
      validateValue(name, region, value);
    }
  }
  for (const builtin of ["escape", "blur"]) {
    if (spec.commands[builtin] !== undefined) {
      throw new Error(
        `mode engine: "${builtin}" is a built-in command; declare esc/blur columns instead`,
      );
    }
  }
  for (const name of Object.keys(spec.available ?? {})) {
    if (spec.commands[name] === undefined && name !== "escape" && name !== "blur") {
      throw new Error(`mode engine: available names unknown command "${name}"`);
    }
  }
  for (const name of Object.keys(spec.commands)) {
    if (name.startsWith("set:")) {
      throw new Error(`mode engine: "${name}" collides with the built-in region setters`);
    }
  }

  // ── initial state ──────────────────────────────────────────────────────────
  const initialEntries: Record<string, RegionValue> = {};
  for (const [name, region] of Object.entries(spec.regions)) {
    initialEntries[name] = region.initial;
  }
  for (const [name, value] of Object.entries(options.initial ?? {})) {
    const region = spec.regions[name];
    if (region === undefined) {
      throw new Error(`mode engine: initial override for unknown region "${name}"`);
    }
    validateValue(name, region, value);
    initialEntries[name] = value;
  }

  let state: EngineState = Object.freeze(initialEntries);
  let ctx: Ctx = options.context;
  const commit = options.commit ?? ((apply: () => void) => apply());
  const listeners = new Set<(state: EngineState, event: EngineEvent) => void>();

  const applyPatch = (base: EngineState, patch: StatePatch | null | undefined): EngineState => {
    if (patch === null || patch === undefined) {
      return base;
    }
    let changed = false;
    const next: Record<string, RegionValue> = { ...base };
    for (const [name, value] of Object.entries(patch)) {
      const region = spec.regions[name];
      if (region === undefined) {
        throw new Error(`mode engine: command patch names unknown region "${name}"`);
      }
      validateValue(name, region, value);
      if (next[name] !== value) {
        next[name] = value;
        changed = true;
      }
    }
    return changed ? Object.freeze(next) : base;
  };

  const applyExcludes = (base: EngineState): EngineState => {
    let current = base;
    for (const rule of spec.excludes ?? []) {
      if (rule.when(current)) {
        current = applyPatch(current, rule.set);
      }
    }
    return current;
  };
  // The initial state satisfies the invariants too: durable adoption can
  // resurrect a combination the excludes forbid (ink persisted true into a
  // disarmed boot, under a disarmed-forces-ink-off rule).
  state = applyExcludes(state);

  const resolveBuiltin = (command: string): StatePatch | null => {
    if (command === "escape") {
      for (const name of spec.escOrder ?? []) {
        const step = escStep(spec.regions[name], state[name]);
        if (step !== null) {
          return { [name]: step };
        }
      }
      return null;
    }
    if (command === "blur") {
      const patch: Record<string, RegionValue> = {};
      for (const [name, region] of Object.entries(spec.regions)) {
        const step = blurStep(region, state[name]);
        if (step !== null) {
          patch[name] = step;
        }
      }
      return Object.keys(patch).length > 0 ? patch : null;
    }
    return null;
  };

  const notify = (event: EngineEvent): void => {
    for (const listener of listeners) {
      listener(state, event);
    }
  };

  // Nested dispatches (a subscriber reacting inside the commit) queue and run
  // after the current commit — single-writer linearity, never interleaving.
  let committing = false;
  const queued: Array<{ command: string; payload: unknown }> = [];
  const drainQueue = (): void => {
    while (queued.length > 0) {
      const next = queued.shift();
      if (next !== undefined) {
        dispatch(next.command, next.payload);
      }
    }
  };

  const dispatch = (command: string, payload?: unknown): EngineState => {
    if (committing) {
      queued.push({ command, payload });
      return state;
    }
    // The availability gate is the machine's, not the bar's. Every caller —
    // a cap, a key, an agent's control() write, a recovered turn — arrives
    // here, so this is the only place the rule can actually hold.
    const gate = spec.available?.[command];
    if (gate !== undefined && !gate(state, ctx)) {
      return state;
    }
    let patch: StatePatch | null | undefined;
    if (command === "escape" || command === "blur") {
      patch = resolveBuiltin(command);
    } else if (command.startsWith("set:")) {
      const name = command.slice(4);
      if (spec.regions[name] === undefined) {
        throw new Error(`mode engine: "${command}" names unknown region "${name}"`);
      }
      patch = { [name]: payload as RegionValue };
    } else {
      const fn = spec.commands[command];
      if (fn === undefined) {
        throw new Error(`mode engine: unknown command "${command}"`);
      }
      patch = fn(state, payload, ctx);
    }

    const before = state;
    const afterCommand = applyPatch(before, patch);
    const after = afterCommand === before ? before : applyExcludes(afterCommand);
    const changed = Object.keys(after).filter((name) => after[name] !== before[name]);
    const event: DispatchEvent = { kind: "dispatch", command, payload, before, after, changed };
    options.onDispatch?.(event);
    if (changed.length === 0) {
      return state;
    }
    state = after;
    committing = true;
    try {
      commit(() => notify(event));
    } finally {
      committing = false;
    }
    drainQueue();
    return state;
  };

  const canDispatch = (command: string, payload?: unknown): boolean => {
    const override = spec.available?.[command];
    if (override !== undefined) {
      return override(state, ctx);
    }
    if (command === "escape" || command === "blur") {
      return resolveBuiltin(command) !== null;
    }
    if (command.startsWith("set:")) {
      return spec.regions[command.slice(4)] !== undefined;
    }
    const fn = spec.commands[command];
    if (fn === undefined) {
      throw new Error(`mode engine: unknown command "${command}"`);
    }
    const patch = fn(state, payload, ctx);
    if (patch === null || patch === undefined) {
      return false;
    }
    // The same pure computation dispatch performs — excludes included, so a
    // reduction the excludes would immediately revert reads as unavailable.
    const after = applyPatch(state, patch);
    if (after === state) {
      return false;
    }
    const final = applyExcludes(after);
    return Object.keys(final).some((name) => final[name] !== state[name]);
  };

  const emit = (event: string, payload?: unknown): EngineState => {
    const binding = spec.on?.[event];
    if (binding === undefined) {
      return state;
    }
    if (typeof binding === "string") {
      return dispatch(binding, payload);
    }
    return dispatch(binding.command, binding.payload !== undefined ? binding.payload : payload);
  };

  return {
    state: () => state,
    context: () => ctx,
    dispatch,
    canDispatch,
    emit,
    setContext: (patch) => {
      ctx = { ...ctx, ...patch };
      committing = true;
      try {
        commit(() => notify({ kind: "context" }));
      } finally {
        committing = false;
      }
      drainQueue();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    spec,
  };
}
