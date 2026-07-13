/**
 * mode-solid.ts — the Solid adapter for the mode engine
 * (docs/proposals/intent-client/01-mode-engine.md §3.3/§3.6; the modal/
 * subpath stays framework-free, so the Solid wiring lives here).
 *
 * What the adapter adds to the pure core:
 *
 *  - **`flush()`-committed dispatch** (write-semantics M2, given one home):
 *    the core's commit hook is `flush`, so subscribers — including the
 *    reactive mirrors below — run inside `flush(fn)`. By the time
 *    `dispatch()` returns, the state signal, every memo over it, and every
 *    effect-driven projection are current. Machine state itself is a plain
 *    frozen object in the core: reading it is NEVER stale, in any tick, from
 *    any scope. The write-then-read-back trap has no surface here.
 *
 *  - **A reactive view**: `state()` is a signal accessor (tracked inside the
 *    graph, committed-fresh at boundaries — the mirrors are only written
 *    inside the synchronous commit); `context()` likewise; `claimStatuses()`
 *    mirrors the claims reconciler's per-claim status for UI.
 *
 *  - **The agent bridge**: regions declaring `agent: "name"` auto-register
 *    a `control()` whose **setter dispatches** `set:<region>` and whose
 *    value follows the region. The engine is the single writer; the control
 *    is a port of it — an agent's `set videoOn true` and the `v` key take
 *    the identical path, which structurally kills the control-mirror desync
 *    class (the old panel's `videoOnLive` bug).
 *
 *  - **Durable adoption**: `durable: true` regions persist through the
 *    durable registry (agent regions ride their control's storage; others
 *    get a `mode:<region>` durableSignal), and their persisted values are
 *    adopted as the engine's initial state — a hot edit never resets what
 *    the user chose.
 */

import { type Accessor, createSignal, flush, type Setter } from "solid-js";
import { type ControlBox, type ControlSpec, control } from "./control";
import { durableSignal } from "./durable";
import {
  type ClaimSpecs,
  type ClaimStatus,
  type ClaimsHandle,
  createClaims,
  createModeEngine,
  type DispatchEvent,
  type EngineEvent,
  type EngineState,
  type ModeEngineSpec,
  type RegionValue,
  type StatePatch,
} from "./modal";

export interface SolidModeEngineConfig<Ctx> {
  spec: ModeEngineSpec<Ctx>;
  /** The world's initial facts. */
  context: Ctx;
  /** Claim derivations + appliers, reconciled after every commit. */
  claims?: ClaimSpecs<EngineState, Ctx>;
  /** Extra initial overrides (recovery mirrors); durable adoption wins last. */
  initial?: StatePatch;
  /** Trace sink — every dispatch (the debug-ui renders mode timelines from it). */
  onDispatch?: (event: DispatchEvent) => void;
}

export interface SolidModeEngine<Ctx> {
  /**
   * Reactive state accessor: tracked inside the graph (JSX, memos, effect
   * computes), committed-fresh at imperative boundaries — safe everywhere.
   */
  state: Accessor<EngineState>;
  /** One region's value (same freshness guarantees). */
  region(name: string): RegionValue;
  /** Reactive context accessor. */
  context: Accessor<Ctx>;
  /** Run a command through the reducer; commits before returning. */
  dispatch(command: string, payload?: unknown): EngineState;
  /** Derived availability (see ModeEngine.canDispatch) — reads the reactive
   * state signal so bar projections re-derive per commit. */
  canDispatch(command: string, payload?: unknown): boolean;
  /** Fire a declared system-event binding. */
  emit(event: string, payload?: unknown): EngineState;
  /** Replace world facts; claims re-derive. */
  setContext(patch: Partial<Ctx>): void;
  subscribe(listener: (state: EngineState, event: EngineEvent) => void): () => void;
  /** Reactive per-claim status map (idle | pending | active | error | stale). */
  claimStatuses: Accessor<Readonly<Record<string, ClaimStatus>>>;
  claims: ClaimsHandle | undefined;
  /** The agent-bridge controls, by region name (registered globally too). */
  controls: Readonly<Record<string, ControlBox<RegionValue>>>;
  readonly spec: ModeEngineSpec<Ctx>;
  /** Release every claim (page teardown; the engine itself is stateless-cheap). */
  dispose(): Promise<void>;
}

export function solidModeEngine<Ctx>(config: SolidModeEngineConfig<Ctx>): SolidModeEngine<Ctx> {
  const { spec } = config;

  // ── durable adoption + agent controls (created BEFORE the engine so their
  // persisted values can seed the initial state) ────────────────────────────
  const controls: Record<string, ControlBox<RegionValue>> = {};
  const mirrors: Array<(state: EngineState) => void> = [];
  const adopted: Record<string, RegionValue> = {};

  for (const [name, region] of Object.entries(spec.regions)) {
    if (region.agent !== undefined) {
      // Built as a value first: the aiui compiler requires literal names on
      // inline control({ … }) objects, and deliberately leaves a non-literal
      // options EXPRESSION alone (the runtime name guard is the backstop) —
      // the documented shape for legitimate dynamic registration like this.
      const controlSpec: ControlSpec<RegionValue> = {
        name: region.agent,
        value: region.initial,
        ...(region.kind === "choice" ? { options: region.values } : {}),
        ...(region.kind === "ladder" ? { options: region.rungs } : {}),
        ...(region.description !== undefined ? { description: region.description } : {}),
      };
      const ctl = control(controlSpec);
      if (region.durable === true) {
        adopted[name] = ctl.get();
      }
      controls[name] = ctl;
      continue;
    }
    if (region.durable === true) {
      const box = durableSignal<RegionValue>(`mode:${name}`, region.initial);
      adopted[name] = box.get();
      mirrors.push((state) => box.set(state[name] as never));
    }
  }

  // ── the core, committing under flush() ────────────────────────────────────
  const engine = createModeEngine(spec, {
    context: config.context,
    initial: { ...(config.initial ?? {}), ...adopted },
    commit: (apply) => flush(apply),
    ...(config.onDispatch !== undefined ? { onDispatch: config.onDispatch } : {}),
  });

  // ── reactive mirrors (written only inside the synchronous commit; ownedWrite
  // so effect handlers may dispatch) ─────────────────────────────────────────
  const [stateSignal, setStateSignal] = createSignal<EngineState>(engine.state(), {
    ownedWrite: true,
  });
  const [contextSignal, setContextSignal] = createSignal<Ctx>(
    // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's own Exclude<T, Function> overload
    engine.context() as Exclude<Ctx, Function>,
    { ownedWrite: true },
  );
  const [claimStatuses, setClaimStatuses] = createSignal<Readonly<Record<string, ClaimStatus>>>(
    {},
    { ownedWrite: true },
  );

  // Finish the agent bridge now that the engine exists: the control's SETTER
  // dispatches (single writer); its stored value FOLLOWS the region.
  for (const [name, ctl] of Object.entries(controls)) {
    const rawSet = ctl.set;
    ctl.set = ((next: RegionValue | ((prev: RegionValue) => RegionValue)) => {
      const resolved =
        typeof next === "function"
          ? (next as (prev: RegionValue) => RegionValue)(engine.state()[name])
          : next;
      engine.dispatch(`set:${name}`, resolved);
      return engine.state()[name]; // post-reducer truth (validation, excludes)
    }) as Setter<RegionValue>;
    mirrors.push((state) => rawSet(state[name] as never));
    // Align the control's stored value with the engine's resolved initial
    // (a config.initial override on a non-durable agent region); same-value
    // writes are dropped by signal equality.
    rawSet(engine.state()[name] as never);
  }

  // ── claims ─────────────────────────────────────────────────────────────────
  const claims =
    config.claims === undefined
      ? undefined
      : createClaims(config.claims, {
          getState: engine.state,
          getCtx: engine.context,
          onStatus: (name, status) => {
            setClaimStatuses((prev) => ({ ...prev, [name]: status }));
          },
        });
  if (claims !== undefined) {
    setClaimStatuses(claims.statuses());
  }

  engine.subscribe((state, event) => {
    if (event.kind === "dispatch") {
      setStateSignal(state);
      for (const mirror of mirrors) {
        mirror(state);
      }
    } else {
      setContextSignal(() => engine.context());
    }
    claims?.reconcile();
  });
  claims?.reconcile(); // the initial state may already desire operations

  return {
    state: stateSignal,
    region: (name) => stateSignal()[name],
    context: contextSignal,
    dispatch: engine.dispatch,
    canDispatch: (command, payload) => {
      void stateSignal(); // subscribe (in-graph callers re-derive per commit)
      return engine.canDispatch(command, payload);
    },
    emit: engine.emit,
    setContext: engine.setContext,
    subscribe: engine.subscribe,
    claimStatuses,
    claims,
    controls,
    spec,
    dispose: async () => {
      await claims?.dispose();
    },
  };
}
