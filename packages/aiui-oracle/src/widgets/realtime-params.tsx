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
import { getPath, SESSION_PARAMS, specApplies } from "../params";
import type { OracleSession } from "../session";
import { ParamRow } from "./param-row";

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
      <div class="aiui-oracle-params-head">
        <span>set</span>
        <span>in force</span>
      </div>
      <For each={SESSION_PARAMS.filter((spec) => specApplies(spec, intended()))}>
        {(spec) => (
          <ParamRow
            spec={spec}
            value={getPath(intended(), spec.path)}
            effective={getPath(effective(), spec.path)}
            disabledReason={reasonFor(spec.when)}
            onChange={(value) => {
              props.session.setSessionParam(spec.path, value);
              bump();
            }}
          />
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
