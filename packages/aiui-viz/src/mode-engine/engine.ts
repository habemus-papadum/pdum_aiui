/**
 * engine.ts — the mode engine: regions, one pure reducer as the only writer,
 * and an atomic commit path. The design note is docs/mode-engine.md (the
 * contract, the pieces retired around it and why, what to consider when
 * their needs return).
 *
 * One clarifying split: every "mode" is two things — a **setting** (what the
 * user chose: standing, often durable) and an **operation** (what the world
 * is doing about it right now: derived, transient, async). Settings live in
 * **regions** — named, independently-valued axes (the state is their product,
 * so orthogonality is by construction and exclusion inside a region is
 * free). Operations are **claims** (./claims.ts) — pure derivations from
 * (regions, context) that a reconciler drives; their status is the "neither
 * on nor off" state, derived and displayable, never stored.
 *
 * **Commands are the only writers.** Keyboard resolver output, button taps,
 * system events (via bindings), tests — all funnel into
 * `dispatch(command, payload)`: a pure reducer `(state, command, ctx) →
 * state'` plus declared cross-region `excludes`, applied once, in
 * declaration order — no fixpoint, no constraint solver. Esc and blur are
 * commands too, resolved mechanically from the spec. When nothing but the
 * reducer writes machine state, "write then read back" has no call sites
 * left to occur at: state is a frozen plain object, never stale to read.
 *
 * **The commit path.** State advances, then subscribers are notified inside
 * the host's `commit` hook (a plain call by default). Three rules keep it
 * linear, and each is pinned by a test:
 *  - a dispatch from inside a subscriber is QUEUED and runs after the current
 *    commit; so is the notification for a `setContext` from inside a
 *    subscriber (the facts change at once — `context()` reads them — the
 *    "context" event waits its turn);
 *  - a throwing subscriber is reported to `onError` (console.error by
 *    default) and the loop goes on: every subscriber hears every commit, in
 *    order, and the queue still drains, so state and notifications cannot
 *    diverge;
 *  - every dispatch is traced through `onDispatch`, no-ops and gate refusals
 *    included.
 *
 * Deliberately NOT here: entry/exit effects (per-event reconciliation beats
 * transition bookkeeping — effects are claims), history states, actor
 * spawning, a statechart library (our chart semantics are small; the value
 * is the integrations, bespoke either way).
 *
 * Realm rules: no Solid import, no DOM — the engine runs in node, workers and
 * tests as plain data + functions. A host mirrors `state()` into its own
 * reactive system from `subscribe`.
 */

/** A region's value: ladders and choices are strings, toggles are booleans. */
export type RegionValue = string | boolean;

/** The engine's state: the product of the regions. Immutable — patch by dispatch. */
export type EngineState = Readonly<Record<string, RegionValue>>;

/** A patch a command returns: region name → new value. */
export type StatePatch = Readonly<Record<string, RegionValue>>;

interface RegionCommon {
  /**
   * Survives reload (a standing setting). The core only carries the flag; a
   * host adapter decides the storage and seeds `initial` from it. No in-repo
   * host acts on it today (docs/mode-engine.md lists it among the features
   * kept for the next host).
   */
  durable?: boolean;
  /**
   * Expose on an agent control surface under this name: a host adapter would
   * register a control whose getter reads the region and whose setter
   * dispatches `set:<region>`, so the engine stays the single writer. The
   * core only carries the name (see `durable`).
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

/**
 * One choice among a set the spec cannot enumerate — registered device ids,
 * open tabs. `accept` is the legality test, consulted at every write (so the
 * set may be live: a registry the host owns); the initial value must pass it
 * too. A value that stops being acceptable stays as state until the next
 * write — states are not revalidated. Esc/blur restore the initial, like a
 * choice.
 */
export interface OpenChoiceRegion extends RegionCommon {
  kind: "open-choice";
  accept: (value: string) => boolean;
  /** Initial value; also what Esc/blur restore. Defaults to `""`. */
  initial: string;
  /** Window blur restores the initial value. */
  blurExits?: boolean;
}

export type RegionSpec = LadderRegion | ToggleRegion | ChoiceRegion | OpenChoiceRegion;

/** The optional flags every region constructor passes through. */
function commonFlags(opts: Partial<RegionCommon>): Partial<RegionCommon> {
  return {
    ...(opts.durable !== undefined ? { durable: opts.durable } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };
}

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
    ...commonFlags(opts),
  };
}

/** Declare a toggle region. */
export function toggle(opts: Partial<Omit<ToggleRegion, "kind">> = {}): ToggleRegion {
  return {
    kind: "toggle",
    initial: opts.initial ?? false,
    ...(opts.blurExits !== undefined ? { blurExits: opts.blurExits } : {}),
    ...commonFlags(opts),
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
    ...commonFlags(opts),
  };
}

/** Declare an open choice region: legality by predicate, not by list. */
export function openChoice(
  accept: (value: string) => boolean,
  opts: Partial<Omit<OpenChoiceRegion, "kind" | "accept">> = {},
): OpenChoiceRegion {
  return {
    kind: "open-choice",
    accept,
    initial: opts.initial ?? "",
    ...(opts.blurExits !== undefined ? { blurExits: opts.blurExits } : {}),
    ...commonFlags(opts),
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
  /**
   * System events → commands (a socket drop, a tab close). Targets are
   * validated at creation: a declared command, `escape`/`blur`, or
   * `set:<region>` of a declared region.
   */
  on?: Readonly<Record<string, EventBinding>>;
  /**
   * Availability overrides. Most commands need none — availability is DERIVED
   * by dry-running the pure reducer ("would it change anything here?"). Verbs
   * (pure effects that move no region) derive to "never", so they declare their
   * gate here; a command whose availability differs from its reduction (an arm
   * gate on a context fact) can override too. Keys must name declared commands.
   *
   * This is a GATE, not a hint: an unavailable command is refused by
   * {@link ModeEngine.dispatch} itself, not merely greyed out by a surface.
   * A button, a key, an agent's write and a recovered turn all arrive as the
   * same dispatch, and a rule that only one surface enforces is a rule that
   * holds until the first other caller.
   */
  available?: Readonly<Record<string, (state: EngineState, ctx: Ctx) => boolean>>;
}

/** One dispatch, as trace data. */
export interface DispatchEvent {
  kind: "dispatch";
  command: string;
  payload: unknown;
  before: EngineState;
  after: EngineState;
  /** The regions this dispatch actually moved (post-excludes). */
  changed: readonly string[];
  /** The availability gate refused it: nothing ran, nothing moved. */
  refused: boolean;
}

export interface ContextEvent {
  kind: "context";
}

export type EngineEvent = DispatchEvent | ContextEvent;

export interface ModeEngineOptions<Ctx> {
  /** The world's initial facts. */
  context: Ctx;
  /**
   * Region overrides adopted at creation (durable recovery: a host passes
   * persisted values). Validated like any patch; the excludes run over the
   * result, so a persisted value cannot resurrect a forbidden combination.
   */
  initial?: StatePatch;
  /**
   * The atomic-commit hook: subscribers are notified inside it. A host with
   * a reactive system passes its synchronous-commit primitive so derived
   * values are current when dispatch returns; the default is a plain call.
   */
  commit?: (apply: () => void) => void;
  /** Trace sink — every dispatch, including no-ops and gate refusals. */
  onDispatch?: (event: DispatchEvent) => void;
  /**
   * Failure sink for a throwing subscriber (console.error by default). The
   * throw is reported, never propagated: the remaining subscribers still
   * hear the commit and the queue still drains.
   */
  onError?: (error: unknown, event: EngineEvent) => void;
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
   * dry-running the pure reducer against the committed state — excludes
   * included, payload included (`set:<region>` with the current value is
   * false); `spec.available` overrides for verbs and gated commands;
   * escape/blur resolve their own steps. Unknown command, unknown region or
   * an illegal value → throws, exactly as dispatch would.
   */
  canDispatch(command: string, payload?: unknown): boolean;
  /** Fire a declared system-event binding; unbound events are ignored. */
  emit(event: string, payload?: unknown): EngineState;
  /**
   * Replace world facts (tab identity, grants, connection, selection).
   * Facts are not choices: no command sets them, they are never durable —
   * but claims derive from them, so subscribers are notified. The facts
   * change at once; from inside a subscriber, the notification queues
   * behind the current commit.
   */
  setContext(patch: Partial<Ctx>): void;
  /** Notified after every commit (dispatch that changed state, or context). */
  subscribe(listener: (state: EngineState, event: EngineEvent) => void): () => void;
  /**
   * The spec, as a frozen snapshot taken at creation — projections read it.
   * Later mutation of the caller's objects changes nothing here; a set that
   * grows at runtime belongs in an {@link openChoice}.
   */
  readonly spec: ModeEngineSpec<Ctx>;
}

/** A deep-frozen copy of the spec: regions and their lists, excludes and their patches, bindings, gates. */
function freezeSpec<Ctx>(spec: ModeEngineSpec<Ctx>): ModeEngineSpec<Ctx> {
  const regions: Record<string, RegionSpec> = {};
  for (const [name, region] of Object.entries(spec.regions)) {
    regions[name] = Object.freeze(
      region.kind === "ladder"
        ? {
            ...region,
            rungs: Object.freeze([...region.rungs]),
            blurExitsFrom: Object.freeze([...region.blurExitsFrom]),
          }
        : region.kind === "choice"
          ? { ...region, values: Object.freeze([...region.values]) }
          : { ...region },
    );
  }
  const frozen: ModeEngineSpec<Ctx> = {
    regions: Object.freeze(regions),
    commands: Object.freeze({ ...spec.commands }),
  };
  if (spec.escOrder !== undefined) {
    frozen.escOrder = Object.freeze([...spec.escOrder]);
  }
  if (spec.excludes !== undefined) {
    frozen.excludes = Object.freeze(
      spec.excludes.map((rule) => Object.freeze({ ...rule, set: Object.freeze({ ...rule.set }) })),
    );
  }
  if (spec.on !== undefined) {
    const on: Record<string, EventBinding> = {};
    for (const [event, binding] of Object.entries(spec.on)) {
      on[event] = typeof binding === "string" ? binding : Object.freeze({ ...binding });
    }
    frozen.on = Object.freeze(on);
  }
  if (spec.available !== undefined) {
    frozen.available = Object.freeze({ ...spec.available });
  }
  return Object.freeze(frozen);
}

function validateValue(name: string, region: RegionSpec, value: RegionValue): void {
  if (region.kind === "toggle") {
    if (typeof value !== "boolean") {
      throw new Error(`mode engine: region "${name}" is a toggle; got ${JSON.stringify(value)}`);
    }
    return;
  }
  if (region.kind === "open-choice") {
    if (typeof value !== "string" || !region.accept(value)) {
      throw new Error(`mode engine: region "${name}" rejected ${JSON.stringify(value)}`);
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
  if (region.kind === "choice" || region.kind === "open-choice") {
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
  if (region.kind === "choice" || region.kind === "open-choice") {
    return region.blurExits === true && value !== region.initial ? region.initial : null;
  }
  if (!region.blurExitsFrom.includes(value as string)) {
    return null;
  }
  const index = region.rungs.indexOf(value as string);
  return index > 0 ? region.rungs[index - 1] : null;
}

/** The regions whose value differs between two states. */
function changedRegions(before: EngineState, after: EngineState): string[] {
  return after === before ? [] : Object.keys(after).filter((name) => after[name] !== before[name]);
}

export function createModeEngine<Ctx>(
  input: ModeEngineSpec<Ctx>,
  options: ModeEngineOptions<Ctx>,
): ModeEngine<Ctx> {
  const spec = freezeSpec(input);

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
  const isDispatchable = (command: string): boolean =>
    spec.commands[command] !== undefined ||
    command === "escape" ||
    command === "blur" ||
    (command.startsWith("set:") && spec.regions[command.slice(4)] !== undefined);
  for (const [event, binding] of Object.entries(spec.on ?? {})) {
    const target = typeof binding === "string" ? binding : binding.command;
    if (!isDispatchable(target)) {
      throw new Error(`mode engine: binding "${event}" targets unknown command "${target}"`);
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
  const report =
    options.onError ??
    ((error: unknown, event: EngineEvent) => {
      const during = event.kind === "dispatch" ? `"${event.command}"` : "a context change";
      console.error(`[aiui-viz/mode-engine] subscriber threw during ${during}`, error);
    });
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

  /** The patch plus the excludes — the one computation dispatch and canDispatch share. */
  const reduce = (base: EngineState, patch: StatePatch | null | undefined): EngineState => {
    const afterCommand = applyPatch(base, patch);
    return afterCommand === base ? base : applyExcludes(afterCommand);
  };

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

  /** What a command resolves to against the committed state: a built-in, a setter, or a declared reduction. */
  const resolvePatch = (command: string, payload: unknown): StatePatch | null | undefined => {
    if (command === "escape" || command === "blur") {
      return resolveBuiltin(command);
    }
    if (command.startsWith("set:")) {
      const name = command.slice(4);
      if (spec.regions[name] === undefined) {
        throw new Error(`mode engine: "${command}" names unknown region "${name}"`);
      }
      return { [name]: payload as RegionValue };
    }
    const fn = spec.commands[command];
    if (fn === undefined) {
      throw new Error(`mode engine: unknown command "${command}"`);
    }
    return fn(state, payload, ctx);
  };

  // Every subscriber hears every commit: a throw is reported and the loop
  // goes on, so the notified world never lags the committed state.
  const notify = (event: EngineEvent): void => {
    for (const listener of listeners) {
      try {
        listener(state, event);
      } catch (error) {
        report(error, event);
      }
    }
  };

  // Work started from inside a commit (a subscriber dispatching, a subscriber
  // changing the context) queues and runs after the current commit —
  // single-writer linearity, never interleaving, whatever the nesting.
  let committing = false;
  const queued: Array<() => void> = [];
  const runCommit = (event: EngineEvent): void => {
    committing = true;
    try {
      commit(() => notify(event));
    } finally {
      committing = false;
    }
    while (queued.length > 0) {
      queued.shift()?.();
    }
  };

  const dispatch = (command: string, payload?: unknown): EngineState => {
    if (committing) {
      queued.push(() => dispatch(command, payload));
      return state;
    }
    // The availability gate is the machine's, not a surface's. Every caller
    // — a button, a key, an agent's write, a recovered turn — arrives here,
    // so this is the only place the rule can actually hold.
    const gate = spec.available?.[command];
    if (gate !== undefined && !gate(state, ctx)) {
      options.onDispatch?.({
        kind: "dispatch",
        command,
        payload,
        before: state,
        after: state,
        changed: [],
        refused: true,
      });
      return state;
    }
    const before = state;
    const after = reduce(before, resolvePatch(command, payload));
    const changed = changedRegions(before, after);
    const event: DispatchEvent = {
      kind: "dispatch",
      command,
      payload,
      before,
      after,
      changed,
      refused: false,
    };
    options.onDispatch?.(event);
    if (changed.length === 0) {
      return state;
    }
    state = after;
    runCommit(event);
    return state;
  };

  const canDispatch = (command: string, payload?: unknown): boolean => {
    const override = spec.available?.[command];
    if (override !== undefined) {
      return override(state, ctx);
    }
    // The same pure computation dispatch performs — excludes included, so a
    // reduction the excludes would immediately revert reads as unavailable.
    return changedRegions(state, reduce(state, resolvePatch(command, payload))).length > 0;
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

  const setContext = (patch: Partial<Ctx>): void => {
    ctx = { ...ctx, ...patch };
    if (committing) {
      queued.push(() => runCommit({ kind: "context" }));
      return;
    }
    runCommit({ kind: "context" });
  };

  return {
    state: () => state,
    context: () => ctx,
    dispatch,
    canDispatch,
    emit,
    setContext,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    spec,
  };
}
