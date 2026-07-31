/**
 * control.tsx — the minimal embeddable strip: start / park / resume / stop, a
 * status dot, the live reply line, and the running usage. Chromeless-core
 * rule: this renders ONLY what the session's state + ledger expose — every
 * piece here works against any transport (capability flags decide extras).
 *
 * Solid 2.0 house rules apply: two-arg createEffect (the one-arg form
 * typechecks but throws MISSING_EFFECT_FN at render), cleanup via onCleanup.
 */

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { OracleSession, OracleState } from "../session";

export interface OracleControlProps {
  session: OracleSession;
}

/** Subscribe a signal to the session's state. */
export function useOracleState(session: OracleSession): () => OracleState {
  const [state, setState] = createSignal(session.state());
  const off = session.onState(setState);
  onCleanup(off);
  return state;
}

export function OracleControl(props: OracleControlProps) {
  const state = useOracleState(props.session);
  const [level, setLevel] = createSignal(0);

  // The "is it hearing me" meter — an AnalyserNode over the mic stream (the
  // runtime's level() idiom: RMS ×3, clamped). Attached while live/parked;
  // torn down with the session.
  createEffect(
    () => state().status,
    (status) => {
      if (status !== "live") {
        setLevel(0);
        return;
      }
      const stream = props.session.micStream();
      if (stream === undefined) {
        return;
      }
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const bytes = new Uint8Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(bytes);
        let sum = 0;
        for (const b of bytes) {
          const v = (b - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / bytes.length) * 3));
      }, 100);
      onCleanup(() => {
        clearInterval(timer);
        void ctx.close();
      });
    },
  );

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
      <span
        class="aiui-oracle-level"
        style={{ opacity: state().status === "live" ? 0.35 + level() * 0.65 : 0.2 }}
      >
        🎙
      </span>
      {state().status === "idle" || state().status === "closed" || state().status === "error" ? (
        <button type="button" onClick={() => void props.session.start()}>
          start
        </button>
      ) : state().status === "parked" ? (
        <button type="button" onClick={() => props.session.resume()}>
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
