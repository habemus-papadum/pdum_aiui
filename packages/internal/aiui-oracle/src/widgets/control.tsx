/**
 * control.tsx — the minimal embeddable strip: start / park / resume / stop, a
 * status dot, the live reply line, and the running usage. Chromeless-core
 * rule: this renders ONLY what the session's state + ledger expose — every
 * piece here works against any transport (capability flags decide extras).
 *
 * Solid 2.0 house rules apply: two-arg createEffect (the one-arg form
 * typechecks but throws MISSING_EFFECT_FN at render), cleanup via onCleanup.
 */

import { activateSessionAudio, type SessionAudio } from "@habemus-papadum/aiui-audio";
import { createSignal, onCleanup } from "solid-js";
import type { OracleSession, OracleState } from "../session";

export interface OracleControlProps {
  session: OracleSession;
  audio?: SessionAudio;
}

/** Subscribe a signal to the session's state. */
export function useOracleState(session: OracleSession): () => OracleState {
  const [state, setState] = createSignal(session.state());
  const off = session.onState(setState);
  onCleanup(off);
  return state;
}

export function OracleControl(props: OracleControlProps) {
  const start = async () => {
    if (props.audio) await activateSessionAudio(props.audio);
    await props.session.start();
  };
  const state = useOracleState(props.session);
  const dot = () => {
    const s = state();
    if (s.status === "live") {
      return s.speaking ? "🔴" : s.replying ? "🔮" : "🟢";
    }
    if (s.status === "parked") {
      return "🟡";
    }
    if (s.status === "error") {
      return "❌";
    }
    return "⚪";
  };

  return (
    <div class="aiui-oracle-control">
      <span class="aiui-oracle-dot" title={state().status}>
        {dot()}
      </span>
      {state().status === "idle" || state().status === "closed" || state().status === "error" ? (
        <button type="button" onClick={() => void start().catch(() => {})}>
          start
        </button>
      ) : state().status === "parked" ? (
        <button
          type="button"
          onClick={() => {
            void (props.audio ? activateSessionAudio(props.audio) : Promise.resolve())
              .then(() => props.session.resume())
              .catch(() => {});
          }}
        >
          resume
        </button>
      ) : (
        <button
          type="button"
          disabled={state().status !== "live"}
          onClick={() => props.session.park()}
        >
          park
        </button>
      )}
      <button
        type="button"
        disabled={state().status === "idle" || state().status === "closed"}
        onClick={() => props.session.close()}
      >
        stop
      </button>
      <button
        type="button"
        disabled={!state().replying}
        onClick={() => props.session.stopSpeaking()}
      >
        shush
      </button>
      <span class="aiui-oracle-reply">{state().replyText}</span>
      {/* The token triple that used to sit here — `input·cached·output` as raw
          numbers — is now `OracleUsage`, which both hosts mount beside this
          strip. Three undifferentiated integers could not say WHICH kind of
          token was accumulating, and audio-vs-text is an ~8× difference in
          what it costs. */}
      {state().playbackBlocked ? (
        <span class="aiui-oracle-blocked">audio blocked — click anywhere</span>
      ) : null}
    </div>
  );
}
