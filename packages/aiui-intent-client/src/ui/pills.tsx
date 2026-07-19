/**
 * pills.tsx — the status-pill strip: internal state an expert wants at a
 * glance (channel · mic · rec · stream · video · ink · keys · ring · sel ·
 * aiui · ipad), plus the REC meter. Claim statuses and context facts,
 * rendered; nothing stored. The ring pill projects through ringForTab — the
 * same pure projection the buses use — so solid-vs-hollow cannot drift from
 * the on-page dot; keeping the ring CSS comment and that projection in this
 * one file preserves the documented color-literal mirror with
 * cdp/page-script.ts assertRing and ext/content.ts.
 */

import type { ClaimStatus } from "@habemus-papadum/aiui-viz/modal";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { type CdpAlignment, describeCdpAlignment, isSharedAlignment } from "../cdp-align";
import type { IntentClient } from "../client";
import { type RingState, ringForTab } from "../transport";

export const PILLS_STYLES = `
  .aiui-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
  .aiui-pill { font-size: 11px; padding: 1px 8px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); opacity: 0.6; }
  .aiui-pill[data-state="on"] { color: #16a34a; border-color: #16a34a; opacity: 1; }
  .aiui-pill[data-state="busy"] { color: #d97706; border-color: #d97706; opacity: 1; }
  .aiui-pill[data-state="err"] { color: #dc2626; border-color: #dc2626; opacity: 1; }
  .aiui-pill[data-state="live"] { color: #fff; background: #dc2626; border-color: #dc2626;
    opacity: 1; font-weight: 600; }
  /* The ring pill mirrors the ON-PAGE dot, not the generic pill palette
     (cdp/page-script.ts assertRing / ext/content.ts — the source of these
     literals): steady PURPLE #7c3aed = armed, breathing RED #dc2626 = turn,
     same 1.6s ease-in-out rhythm. Solid dot = FILLED pill; the dot's fourth
     state — HOLLOW, "this tab's pixels need a grant" — is the outline pill
     (dashed, so a glance says "missing something"). The two can't share a
     clock across documents, so what aligns is color + cadence, not phase. */
  .aiui-pill[data-pill="ring"][data-state="on"] { color: #fff; background: #7c3aed;
    border-color: #7c3aed; font-weight: 600; }
  .aiui-pill[data-pill="ring"][data-state="on"][data-hollow] { color: #7c3aed;
    background: transparent; border: 1px dashed #7c3aed; font-weight: 400; }
  .aiui-pill[data-pill="ring"][data-state="live"] {
    animation: aiui-ring-breathe 1.6s ease-in-out infinite; }
  .aiui-pill[data-pill="ring"][data-state="live"][data-hollow] { color: #dc2626;
    background: transparent; border: 1px dashed #dc2626; font-weight: 400; }
  @keyframes aiui-ring-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  /* The cdp pill's SHARED face: aligned, and other channels co-drive this
     browser (a supported multi-agent workflow) — purple, like the ring's
     armed tone, distinct from the solo green. */
  .aiui-pill[data-pill="cdp"][data-shared] { color: #fff; background: #7c3aed;
    border-color: #7c3aed; opacity: 1; font-weight: 600; }
  /* The REC meter rides with the pills (it renders inside the strip). */
  .aiui-meter { display: inline-block; width: 64px; height: 8px; border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); overflow: hidden;
    vertical-align: middle; }
  .aiui-meter > div { height: 100%; background: #dc2626; transition: width 80ms linear; }
`;

/** One status pill's view: stable label, varying state. */
interface Pill {
  label: string;
  state: "off" | "on" | "busy" | "err" | "live";
  detail?: string;
  /** The ring pill's fourth axis: armed/turn but the tab IN VIEW lacks the
   * grant — rendered outline-only, like the on-page hollow dot. */
  hollow?: boolean;
  /** The cdp pill's co-driving axis: aligned AND other channels drive the
   * same browser — rendered purple. */
  shared?: boolean;
}

const claimPillState = (status: ClaimStatus | undefined): Pill["state"] => {
  switch (status?.phase) {
    case "active":
      return "on";
    case "pending":
    case "stale":
      return "busy";
    case "error":
      return "err";
    default:
      return "off";
  }
};

/** The cdp pill's face per alignment state: green = the agent's DevTools see
 * THIS browser; red = this browser is driven by a DIFFERENT channel; amber =
 * the agent's browser is elsewhere; gray = no CDP / unknown (normal in an
 * everyday Chrome with no session browser). */
const cdpPillState = (alignment: CdpAlignment | undefined): Pill["state"] => {
  switch (alignment?.state) {
    case "aligned":
      return "on";
    case "driven-by-other":
      return "err";
    case "channel-drives-other":
      return "busy";
    default:
      return "off"; // channel-no-cdp / unknown / not yet derived
  }
};

/** The expert strip: claim statuses + context facts, plus the REC meter. */
export function StatusPills(props: { client: IntentClient; micLevel?: () => number }) {
  const { client } = props;

  // The REC meter: poll talk.level while a talk window is open (display
  // state at display cadence — the machine is untouched).
  const [micLevel, setMicLevel] = createSignal(0, { ownedWrite: true });
  let meterTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(
    () => client.state().talk !== "off" && props.micLevel !== undefined,
    (talking) => {
      clearInterval(meterTimer);
      if (talking) {
        meterTimer = setInterval(() => setMicLevel(props.micLevel?.() ?? 0), 100);
      } else {
        setMicLevel(0);
      }
    },
  );
  onCleanup(() => clearInterval(meterTimer));

  const pills = createMemo((): Pill[] => {
    const state = client.state();
    const ctx = client.context();
    const claims = client.claimStatuses();
    const talk = state.talk as string;
    return [
      { label: "channel", state: ctx.connected ? "on" : "off" },
      {
        label: "cdp",
        state: cdpPillState(ctx.cdpAlignment),
        detail: describeCdpAlignment(ctx.cdpAlignment),
        ...(isSharedAlignment(ctx.cdpAlignment) ? { shared: true } : {}),
      },
      {
        label: "mic",
        state: ctx.micGranted === undefined ? "off" : ctx.micGranted ? "on" : "err",
        detail: ctx.micGranted === undefined ? "not asked" : ctx.micGranted ? "granted" : "denied",
      },
      {
        label: "rec",
        state: talk === "off" ? "off" : state.micMuted === true ? "busy" : "live",
        detail: talk === "off" ? undefined : state.micMuted === true ? `${talk} · muted` : talk,
      },
      { label: "stream", state: claimPillState(claims.tabStream) },
      { label: "video", state: claimPillState(claims.videoSample) },
      { label: "ink", state: claimPillState(claims.inkPointer) },
      { label: "keys", state: claimPillState(claims.keyRouting) },
      ((): Pill => {
        // The ring pill IS the on-page dot, projected onto the tab in view —
        // through ringForTab, the same pure projection every bus uses, so the
        // solid-vs-hollow verdict cannot drift from what the page shows.
        const desire = claims.ring?.desire as RingState | undefined;
        if (desire?.on !== true) {
          return {
            label: "ring",
            state: "off",
            detail: "off · purple=armed · red pulse=turn (the on-page dot, mirrored)",
          };
        }
        const page = ringForTab(desire, ctx.activeTab ?? -1);
        return {
          label: "ring",
          state: desire.turnTone ? "live" : "on",
          ...(page.hollow === true ? { hollow: true } : {}),
          detail:
            page.hollow === true
              ? `this tab's pixels need the grant — press ${page.hint ?? "activate"}`
              : "off · purple=armed · red pulse=turn (the on-page dot, mirrored)",
        };
      })(),
      {
        label: "sel",
        state: ctx.selectionPresent ? "on" : "off",
        detail: ctx.selectionPresent ? "the page has a live selection" : "no selection",
      },
      {
        label: "aiui",
        state: ctx.aiuiPage ? "on" : "off",
        detail: ctx.aiuiPage ? "aiui-instrumented (jump capable)" : "not instrumented",
      },
      {
        label: "ipad",
        state: ctx.pencilClients > 0 ? "on" : "off",
        detail: `${ctx.pencilClients}`,
      },
    ];
  });

  return (
    <div class="aiui-pills" data-testid="pills">
      <For each={pills()}>
        {(pill) => (
          <span
            class="aiui-pill"
            data-pill={pill.label}
            data-state={pill.state}
            data-hollow={pill.hollow === true ? "" : undefined}
            data-shared={pill.shared === true ? "" : undefined}
            title={pill.detail}
          >
            {pill.label}
          </span>
        )}
      </For>
      <Show when={client.state().talk !== "off" && props.micLevel !== undefined}>
        <span class="aiui-meter" data-testid="mic-meter" title="mic level">
          <div style={`width: ${Math.round(Math.min(1, micLevel()) * 100)}%`} />
        </span>
      </Show>
    </div>
  );
}
