/**
 * control.tsx — the minimal strip: connect / close / mute, a status dot
 * that shows who is speaking, a mic level meter, and the running meter
 * (seconds, dollars, context). Everything here is transport-neutral.
 */

import { createEffect, createSignal, Show } from "solid-js";
import { formatSeconds, formatUsd, priceLiveSeconds } from "../cost";
import type { LiveSession } from "../session";
import { useLiveState } from "./state";

export interface LiveControlProps {
  session: LiveSession;
  /** Extra buttons, rendered after the built-ins. */
  children?: unknown;
}

export function LiveControl(props: LiveControlProps) {
  const state = useLiveState(props.session);
  const [level, setLevel] = createSignal(0);

  // The "is it hearing me" meter — an AnalyserNode over the mic stream (the
  // oracle's idiom). The effect RETURNS its teardown: Solid 2 runs it before
  // the next status change and on unmount (onCleanup inside an effect body
  // is not owned and warns NO_OWNER_CLEANUP).
  createEffect(
    () => state().status,
    (status) => {
      if (status !== "live") {
        setLevel(0);
        return;
      }
      const stream = props.session.micStream();
      if (stream === undefined || typeof AudioContext === "undefined") {
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
      return () => {
        clearInterval(timer);
        void ctx.close();
      };
    },
  );

  const dot = () => {
    const s = state();
    if (s.status === "live") {
      return s.assistantSpeaking ? "🔮" : s.userSpeaking ? "🔴" : s.openTasks > 0 ? "🟠" : "🟢";
    }
    if (s.status === "connecting" || s.status === "closing") {
      return "🟡";
    }
    if (s.status === "error") {
      return "❌";
    }
    return "⚪";
  };

  const title = () => {
    const s = state();
    const bits: string[] = [s.status];
    if (s.status === "live") {
      bits.push(
        s.assistantSpeaking
          ? "assistant speaking"
          : s.userSpeaking
            ? "you are speaking"
            : s.openTasks > 0
              ? `${s.openTasks} task(s) open`
              : "listening",
      );
    }
    return bits.join(" · ");
  };

  const canStart = () => ["idle", "closed", "error"].includes(state().status);

  return (
    <div class="aiui-live-control" data-status={state().status}>
      <span class="aiui-live-dot" title={title()}>
        {dot()}
      </span>
      <span
        class="aiui-live-level"
        style={{ opacity: state().status === "live" ? 0.35 + level() * 0.65 : 0.2 }}
      >
        🎙
      </span>
      <Show
        when={canStart()}
        fallback={
          <button
            type="button"
            disabled={state().status !== "live"}
            onClick={() => void props.session.close()}
          >
            close
          </button>
        }
      >
        <button type="button" onClick={() => void props.session.start().catch(() => {})}>
          connect
        </button>
      </Show>
      <button
        type="button"
        disabled={state().status !== "live"}
        onClick={() => props.session.mute(!state().muted)}
        title="mute both ways: the mic track and the server-side mute (still billed)"
      >
        {state().muted ? "unmute" : "mute"}
      </button>
      <span
        class="aiui-live-meter"
        title="billed seconds · voice cost at $0.05/min · context window used"
      >
        <span>{formatSeconds(state().seconds)}</span>
        <span class="aiui-live-meter-cost">{formatUsd(priceLiveSeconds(state().seconds))}</span>
        <span>{Math.round(state().contextRatio * 100)}% ctx</span>
      </span>
      <Show when={state().sessionId}>
        {(id) => (
          <span class="aiui-live-session-id" title={id()}>
            {id().slice(0, 12)}…
          </span>
        )}
      </Show>
      <Show when={state().error}>{(error) => <span class="aiui-live-error">{error()}</span>}</Show>
      <Show when={state().playbackBlocked}>
        <span class="aiui-live-blocked">audio blocked — click anywhere</span>
      </Show>
      <Show when={state().status === "closed" && state().closeReason}>
        {(reason) => <span class="aiui-live-closed">closed: {reason()}</span>}
      </Show>
      {props.children as never}
    </div>
  );
}
