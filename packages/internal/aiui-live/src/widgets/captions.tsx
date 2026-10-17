/**
 * captions.tsx — two revisable rows: what the user is saying and what the
 * assistant is saying, each the CURRENT utterance (fragments regrouped by
 * silence), lit while its side is speaking. Full duplex means both can be
 * lit at once — that is the point of two rows.
 */

import type { LiveSession } from "../session";
import { useLiveState } from "./state";

export interface LiveCaptionsProps {
  session: LiveSession;
}

export function LiveCaptions(props: LiveCaptionsProps) {
  const state = useLiveState(props.session);
  return (
    <div class="aiui-live-captions">
      <div class="aiui-live-caption" data-role="user" data-speaking={String(state().userSpeaking)}>
        <span class="aiui-live-caption-role">you</span>
        <span class="aiui-live-caption-text">{state().captions.user}</span>
      </div>
      <div
        class="aiui-live-caption"
        data-role="assistant"
        data-speaking={String(state().assistantSpeaking)}
      >
        <span class="aiui-live-caption-role">oracle</span>
        <span class="aiui-live-caption-text">{state().captions.assistant}</span>
      </div>
    </div>
  );
}
