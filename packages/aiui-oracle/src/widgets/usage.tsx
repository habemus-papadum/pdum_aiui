/**
 * usage.tsx — what the session has consumed, always visible, at a glance.
 *
 * The design constraint is that this is read PERIPHERALLY: it sits in a strip
 * you are not looking at, and it has to answer "is this getting expensive?"
 * without being read word by word. So every figure is one glyph pair and an
 * abbreviated count — direction as an arrow, kind as an icon:
 *
 *   ↑🎙 12.4k   ↑📝 3.1k   ⚡ 9.8k   ↓🔊 5.2k   ↓📝 1.1k   $0.042
 *
 * Direction is encoded TWICE on the audio chips (↑ with a microphone, ↓ with a
 * speaker), because those are the two that dominate the bill and confusing
 * them inverts the reading — audio out costs twice audio in.
 *
 * The cached chip has no arrow on purpose. It is a subset of the input, not a
 * fourth direction, and it is the one number you want to go UP: at a ~98%
 * discount it is the single biggest lever on what a long conversation costs.
 *
 * Text figures are derived (total − audio) rather than reported, which is the
 * vendor's own convention and genai-prices': the modality counts are subsets.
 */

import { Show } from "solid-js";
import { abbreviateTokens, formatUsd } from "../cost";
import type { OracleSession } from "../session";
import type { UsageTotals } from "../types";
import { useOracleState } from "./control";

export interface OracleUsageProps {
  session: OracleSession;
}

/** One chip: an icon pair, a count, and a title that spells it out — the
 * glyphs are for the glance, the title for the first time you see them. */
function Chip(props: { icon: string; label: string; count: number; kind: string }) {
  return (
    <span class="aiui-oracle-usage-chip" data-kind={props.kind} title={props.label}>
      <span class="aiui-oracle-usage-icon">{props.icon}</span>
      {abbreviateTokens(props.count)}
    </span>
  );
}

/** The rows the strip shows, given a tally. Text is what is left after audio. */
export function usageChips(
  usage: UsageTotals,
): Array<{ icon: string; label: string; count: number; kind: string }> {
  const inputText = Math.max(0, usage.inputTokens - usage.inputAudioTokens);
  const outputText = Math.max(0, usage.outputTokens - usage.outputAudioTokens);
  return [
    {
      icon: "↑🎙",
      label: "audio you spoke (input audio tokens)",
      count: usage.inputAudioTokens,
      kind: "in-audio",
    },
    {
      icon: "↑📝",
      label: "text sent — instructions, tools, transcripts, injections",
      count: inputText,
      kind: "in-text",
    },
    {
      icon: "⚡",
      label: "cached input — a subset of the input, billed at a deep discount",
      count: usage.cachedInputTokens,
      kind: "cached",
    },
    {
      icon: "↓🔊",
      label: "audio it spoke (output audio tokens) — the priciest per token",
      count: usage.outputAudioTokens,
      kind: "out-audio",
    },
    {
      icon: "↓📝",
      label: "text it produced — transcripts and tool arguments",
      count: outputText,
      kind: "out-text",
    },
  ].filter((chip) => chip.count > 0);
}

export function OracleUsage(props: OracleUsageProps) {
  const state = useOracleState(props.session);
  const usage = () => state().usage;
  return (
    <Show when={usage().responses > 0}>
      <div class="aiui-oracle-usage" data-testid="oracle-usage">
        {usageChips(usage()).map((chip) => (
          <Chip icon={chip.icon} label={chip.label} count={chip.count} kind={chip.kind} />
        ))}
        <Show when={usage().usd !== undefined}>
          <span
            class="aiui-oracle-usage-cost"
            title={
              usage().approximateResponses > 0
                ? "approximate — this model id is not in the price catalog, so its base model's rates were used. From @pydantic/genai-prices; a signal, not an invoice."
                : "estimated from @pydantic/genai-prices — a signal, not an invoice"
            }
          >
            {usage().approximateResponses > 0 ? "~" : ""}
            {formatUsd(usage().usd ?? 0)}
          </span>
        </Show>
        {/* Never fold an unknown price into the total as zero: a cost display
            that under-reports without saying so is worse than none. */}
        <Show when={usage().unpricedResponses > 0}>
          <span
            class="aiui-oracle-usage-unpriced"
            title="the price catalog has no entry for this model — the total is at least this much"
          >
            +{usage().unpricedResponses} unpriced
          </span>
        </Show>
      </div>
    </Show>
  );
}
