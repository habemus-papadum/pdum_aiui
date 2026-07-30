/**
 * webrtc-params.tsx — the mic track's constraints, live.
 *
 * The sibling of the Realtime params widget and deliberately the same shape,
 * but the two read-backs come from different worlds: this one applies through
 * `MediaStreamTrack.applyConstraints()` and reads `getSettings()`.
 *
 * Three things are honest here that a constraints UI usually is not:
 *
 *  - **Support is asked, not assumed.** `getSupportedConstraints()` is the
 *    browser's own list; anything missing from it renders disabled rather than
 *    as a control that silently does nothing.
 *  - **A resolved `applyConstraints` is not proof.** The settings are re-read
 *    afterwards, so a call that succeeds without changing anything still shows
 *    the old value in the "in force" column, and the row marks drift.
 *  - **A rejection is shown, not swallowed.** `OverconstrainedError` is the
 *    normal way a device says no, and it is the most useful thing on screen
 *    when it happens.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import { CONSTRAINT_PARAMS, getPath } from "../params";
import type { OracleSession } from "../session";
import { ParamRow } from "./param-row";

export interface OracleWebRtcParamsProps {
  session: OracleSession;
}

/** The browser's own constraint list — empty when the API is absent (a
 * non-browser test host), which reads as "nothing supported" and disables
 * every row rather than pretending. */
function supportedConstraints(): Record<string, unknown> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  return (media?.getSupportedConstraints?.() ?? {}) as unknown as Record<string, unknown>;
}

export function OracleWebRtcParams(props: OracleWebRtcParamsProps) {
  const supported = supportedConstraints();
  const [tick, setTick] = createSignal(0);
  const bump = () => setTick((n) => n + 1);
  const [error, setError] = createSignal<string | undefined>(undefined);
  /** What we ASKED for, which `getSettings()` may not agree with — that
   * disagreement is the whole point of the "in force" column. */
  const [asked, setAsked] = createSignal<Record<string, unknown>>({});
  onCleanup(props.session.onState(bump));

  const settings = () => {
    tick();
    return props.session.audioSettings();
  };
  const status = () => {
    tick();
    return props.session.state().status;
  };
  const open = () => status() === "live" || status() === "parked";

  const reasonFor = (name: string, when: string): string | undefined => {
    if (supported[name] !== true) {
      return "unsupported by this browser";
    }
    if (when === "connect") {
      return "connect-time only";
    }
    return open() ? undefined : "needs a live session";
  };

  const apply = (name: string, value: unknown) => {
    setAsked({ ...asked(), [name]: value });
    setError(undefined);
    props.session
      .applyAudioConstraints({ [name]: value } as MediaTrackConstraints)
      .catch((cause: unknown) => {
        // A device saying no is expected traffic, not a crash — name it and
        // leave the row showing what is really in force.
        setError(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
      })
      .finally(bump);
  };

  return (
    <div class="aiui-oracle-params" data-testid="oracle-webrtc-params">
      <div class="aiui-oracle-params-head">
        <span>asked</span>
        <span>in force</span>
      </div>
      <For each={CONSTRAINT_PARAMS}>
        {(spec) => (
          <ParamRow
            spec={spec}
            value={asked()[spec.name]}
            effective={getPath(settings(), spec.path)}
            disabledReason={reasonFor(spec.name, spec.when)}
            onChange={(value) => apply(spec.name, value)}
          />
        )}
      </For>
      <Show when={error()}>{(message) => <p class="aiui-oracle-params-error">{message()}</p>}</Show>
      <Show when={open() && settings() === undefined}>
        <p class="aiui-oracle-params-note">
          this transport has no local mic track — nothing to constrain.
        </p>
      </Show>
    </div>
  );
}
