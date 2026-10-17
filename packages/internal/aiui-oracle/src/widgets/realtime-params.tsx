/**
 * realtime-params.tsx — every Realtime session parameter we expose, live.
 *
 * Named for the vendor's own name for the API (Realtime), per the same rule
 * that governs the field labels.
 *
 * The widget holds no state of its own. It renders the session's intended
 * config against the last `session.updated` echo and writes through
 * `setSessionParam`, so what you see is what the engine would send and what
 * the server said it holds — never a local copy that can drift from either.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import { getPath, groupSpecs, SESSION_PARAMS, specApplies } from "../params";
import type { OracleSession } from "../session";
import { ParamGroup, ParamRow } from "./param-row";

export interface OracleRealtimeParamsProps {
  session: OracleSession;
}

export function OracleRealtimeParams(props: OracleRealtimeParamsProps) {
  // One tick drives re-reads of both sides. The config changes when WE write
  // it; the echo changes when the server acks — and every ack lands in the
  // ledger, so one subscription covers both.
  const [tick, setTick] = createSignal(0);
  const bump = () => setTick((n) => n + 1);
  onCleanup(props.session.onLedger(bump));
  onCleanup(props.session.onState(bump));

  const intended = () => {
    tick();
    return props.session.sessionConfig();
  };
  const ours = () => {
    tick();
    return props.session.behavior();
  };
  const effective = () => {
    tick();
    return props.session.effectiveSession();
  };
  const status = () => {
    tick();
    return props.session.state().status;
  };
  const open = () => status() === "live" || status() === "parked";
  /** The vendor freezes `voice` once the model has SPOKEN, which is not the
   * same as connect — so the test is whether a response has happened. */
  const hasSpoken = () => {
    tick();
    return props.session.state().usage.responses > 0;
  };

  const reasonFor = (when: string): string | undefined => {
    if (when === "connect") {
      return open() ? "connect-time only" : undefined;
    }
    if (!open()) {
      return "needs a live session";
    }
    if (when === "before-first-reply" && hasSpoken()) {
      return "frozen once it has spoken";
    }
    return undefined;
  };

  return (
    <div class="aiui-oracle-params" data-testid="oracle-realtime-params">
      <For each={groupSpecs(SESSION_PARAMS.filter((spec) => specApplies(spec, intended())))}>
        {(group) => (
          <ParamGroup name={group.name}>
            <For each={group.specs}>
              {(spec) => (
                <ParamRow
                  spec={spec}
                  value={
                    spec.scope === "aiui"
                      ? getPath(ours(), spec.path)
                      : getPath(intended(), spec.path)
                  }
                  // An aiui knob has no server to disagree with, so what is
                  // in force IS what we hold — never "—", never drift.
                  effective={
                    spec.scope === "aiui"
                      ? getPath(ours(), spec.path)
                      : getPath(effective(), spec.path)
                  }
                  // …and it applies with no session open, because parking is
                  // ours to schedule whether or not the vendor is listening.
                  disabledReason={spec.scope === "aiui" ? undefined : reasonFor(spec.when)}
                  onChange={(value) => {
                    if (spec.scope === "aiui") {
                      props.session.setBehavior(spec.path, value);
                    } else {
                      props.session.setSessionParam(spec.path, value);
                    }
                    bump();
                  }}
                />
              )}
            </For>
          </ParamGroup>
        )}
      </For>
      <Show when={effective() === undefined}>
        <p class="aiui-oracle-params-note">
          nothing acked yet — the “in force” column fills in on the first
          <code>session.updated</code>.
        </p>
      </Show>
    </div>
  );
}
