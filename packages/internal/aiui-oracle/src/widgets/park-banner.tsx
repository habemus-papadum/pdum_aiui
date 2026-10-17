/**
 * park-banner.tsx — the standing notice that the session is parked, and the
 * one click that undoes it.
 *
 * Why a banner rather than the mind strip's parked line (which already
 * exists): the strip answers "what is it doing right now" for someone already
 * looking at it. This is for someone who ISN'T — who walked away, came back,
 * and needs to know at a glance that the microphone is closed and the
 * conversation is still there. Those are different jobs, and the second one
 * has to be impossible to miss.
 *
 * It distinguishes the two ways a session parks. Parking it yourself is a
 * thing you remember doing; being parked because you left is news, and the
 * banner says which happened — otherwise coming back to a silent session is
 * indistinguishable from coming back to a broken one.
 */

import { Show } from "solid-js";
import type { OracleSession } from "../session";
import { useOracleState } from "./control";

export interface OracleParkBannerProps {
  session: OracleSession;
}

export function OracleParkBanner(props: OracleParkBannerProps) {
  const state = useOracleState(props.session);
  const idle = () => state().parkedReason === "idle";
  return (
    <Show when={state().status === "parked"}>
      <div class="aiui-oracle-park" data-reason={state().parkedReason ?? "manual"}>
        <span class="aiui-oracle-park-icon">⏸</span>
        <span class="aiui-oracle-park-text">
          {idle()
            ? `parked after ${props.session.behavior().parkAfterIdleSeconds}s idle — the mic is closed`
            : "parked — the mic is closed"}
          {/* The reassurance matters as much as the notice: what was lost is
              nothing, and saying so is what makes an auto-park acceptable
              rather than something to switch off. */}
          <span class="aiui-oracle-park-note"> · session kept, costs nothing</span>
        </span>
        <button type="button" onClick={() => props.session.resume()}>
          resume
        </button>
      </div>
    </Show>
  );
}
