/**
 * control.tsx — the minimal strip: connect / close / mute, a status dot
 * that shows who is speaking, and the running meter
 * (seconds, dollars, context). Everything here is transport-neutral.
 */

import { activateSessionAudio, type SessionAudio } from "@habemus-papadum/aiui-audio";
import { Show } from "solid-js";
import { formatSeconds, formatUsd, priceLiveSeconds } from "../cost";
import type { LiveSession } from "../session";
import { useLiveState } from "./state";

export interface LiveControlProps {
  session: LiveSession;
  audio?: SessionAudio;
  /** Extra buttons, rendered after the built-ins. */
  children?: unknown;
}

export function LiveControl(props: LiveControlProps) {
  const start = async () => {
    if (props.audio) await activateSessionAudio(props.audio);
    await props.session.start();
  };
  const state = useLiveState(props.session);
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
        <button type="button" onClick={() => void start().catch(() => {})}>
          connect
        </button>
      </Show>
      <button
        type="button"
        disabled={state().status !== "live"}
        onClick={() => props.session.mute(!state().muted)}
        title="mute both ways: the input endpoint and the server-side mute (still billed)"
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
