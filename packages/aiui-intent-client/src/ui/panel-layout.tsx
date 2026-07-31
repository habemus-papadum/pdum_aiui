/**
 * PanelLayout — the panel's render tree, shared by both entries.
 *
 * The plain page (ui/main.tsx) and the MV3 side panel (ext/panel.tsx) are two
 * shells around the same client: they differ only in HOW the host and channel
 * are wired, never in what the panel LOOKS like. This is that look, in one
 * place — so "the two entries read identically" is structural, not a comment
 * each file has to keep honoring by hand.
 *
 * The three places the shells legitimately differ are props, not forks:
 *  - `listChannels`/`onSwitch` — how a channel is listed and switched (the
 *    page rebinds via its URL; the extension via chrome.storage + reload);
 *  - `targetTab` — only the CDP tier aims at a real tab worth naming (the
 *    extension drives its own tab; the fake tier has none);
 *  - `debug` — the debugging pane's shell-specific content and whether it
 *    starts open (the page's simulate strip; the extension's CDP verdict).
 */

import {
  ORACLE_WIDGET_STYLES,
  OracleMind,
  OracleParkBanner,
  OracleRealtimeParams,
  OracleUsage,
  OracleViewer,
  OracleWebRtcParams,
} from "@habemus-papadum/aiui-oracle/widgets";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { IntentClient } from "../client";
import type { ChannelLanes } from "../lanes";
import { CHANNEL_HEADER_STYLES, ChannelHeader, type ChannelListing } from "./channel-header";
import { Panel } from "./panel";
import { PANES_STYLES } from "./panes";
import { SESSION_NAME_STYLES, SessionNameChip, type SessionNameControl } from "./session-name-chip";
import { type Narration, WirePane } from "./shell";
import { TARGET_TAB_STYLES } from "./target-tab";
import { RichTracePane, TRACE_PANE_STYLES } from "./trace-pane";
import { TURN_PREVIEW_STYLES, TurnPreview } from "./turn-preview";

/** Every stylesheet the layout's panes need, concatenated (emitted once). */
export const PANEL_LAYOUT_STYLES =
  PANES_STYLES +
  TURN_PREVIEW_STYLES +
  TRACE_PANE_STYLES +
  CHANNEL_HEADER_STYLES +
  SESSION_NAME_STYLES +
  TARGET_TAB_STYLES +
  // The oracle widgets ship their own (theme-neutral) rules — the same
  // host-concatenates-strings pattern as every strip above.
  ORACLE_WIDGET_STYLES +
  `.aiui-oracle-panes { margin: 4px 12px; max-width: 460px; }
  /* The section's own label — quiet, but unmistakably a heading, and set off
     by a rule so the folds below read as belonging to it. */
  .aiui-oracle-panes-title { font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; opacity: 0.55; padding: 2px 0 3px; margin-bottom: 3px;
    border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  /* Quiet by default; the off-view case is the one worth a colour, since it
     is the state that used to read as "the oracle can't see my app". */
  .aiui-oracle-source { font-size: 11px; opacity: 0.55; padding: 0 2px 2px; }
  .aiui-oracle-source strong { font-weight: 600; }
  .aiui-oracle-source[data-off-view] { opacity: 1; color: #d97706; }`;

export interface PanelLayoutProps {
  /** The channel this panel is bound to (undefined = none found). */
  port: number | undefined;
  /** The session-bus phase — the header dot's color (a reactive read). */
  phase: () => "connected" | "connecting" | "closed";
  /** How the header lists channels (URL registry vs the extension's native host). */
  listChannels: () => Promise<ChannelListing>;
  /** How the header rebinds to another channel (URL assign vs storage + reload). */
  onSwitch: (port: number) => void;
  /** The intent client this panel drives. */
  client: IntentClient;
  /** Registers the UI-local blip sink (blips are display-only state). */
  registerBlipSink?: (sink: (key: string) => void) => void;
  /** Live mic level 0..1 when the tier supplies one — drives the REC meter. */
  micLevel?: () => number;
  /** The channel lanes; their presence gates the turn preview and trace panes. */
  lanes?: ChannelLanes;
  /** The panes' shared narration (status line, toast, lowered prompt). */
  narration: Narration;
  /** The panel's remote identity (the iPad pickers' display name) + renamer.
   * Absent when no channel is bound — with no relay there is nobody to name
   * this panel to. */
  sessionName?: SessionNameControl;
  /** The CDP tier's target-tab strip; absent in every other tier. */
  targetTab?: JSX.Element;
  /** The debugging pane's shell-specific content and whether it starts open.
   * No content, no pane (owner, 2026-07-19): the extension passes none now —
   * its CDP verdict moved to the console (toast on mismatch) — so only the
   * plain page's simulate strip still renders here. */
  debug?: { open?: boolean; content?: JSX.Element };
}

/**
 * The capture-grant banner (owner, 2026-07-20): standing, quiet, and shown
 * exactly while the tab in view lacks the invocation-gated `tabCapture` grant
 * — it disappears the moment the grant lands (and reappears on a switch to an
 * ungranted tab). It names BOTH remedies, context menu first (the toolbar
 * icon may be unpinned). Derived from context alone, so it needs no host
 * knowledge: grantless hosts (CDP, the fake tier) keep `grantedTab` in
 * lockstep with `activeTab` (client.ts), so the condition is only ever true
 * on the extension host — structurally, not by a prop each shell must wire.
 * Text/talk/page acts never needed the grant, and the second line says so —
 * the banner is a signpost, not an error (that is why it is not a toast).
 */
function GrantBanner(props: { client: IntentClient }) {
  const needsGrant = (): boolean => {
    const ctx = props.client.context();
    return ctx.activeTab !== undefined && ctx.grantedTab !== ctx.activeTab;
  };
  return (
    <Show when={needsGrant()}>
      <div
        data-testid="grant-banner"
        style="margin: 8px 12px; font: 12px system-ui; border: 1px solid #d97706; border-radius: 6px; padding: 6px 8px; max-width: 460px"
      >
        <div>
          <strong>capture not granted for this tab</strong> — right-click the page →{" "}
          <em>aiui: grant capture on this tab</em>, or click the aiui toolbar button (pin it for
          one-click grants).
        </div>
        <div style="opacity: 0.7; margin-top: 2px">
          talk, text, selection, and pencil work without it; shots, video, and the iPad's picture
          need it.
        </div>
      </div>
    </Show>
  );
}

/**
 * The paused banner (owner, 2026-07-30): standing and quiet like the grant
 * banner — never a toast — shown exactly while an open turn is PAUSED, gone
 * the moment it resumes or closes. The real hazard of the pause feature is
 * briefing into the void (a lit ⏸ cap and a dark REC pill are weak signals),
 * so the banner says plainly that nothing is being collected. The REASON
 * lives here and only here — the stream's pause bracket is deliberately
 * reason-free (BEHAVIOR.md); when the oracle detour lands it swaps in its own
 * line ("oracle live — the turn is paused") through this same component.
 */
function PausedBanner(props: { client: IntentClient }) {
  // Two ways a turn stops collecting, and the banner is the ONE place the
  // difference is spelled out (the stream's pause bracket is reason-free by
  // decision): the ⏸ cap, or the oracle taking the sink (O3a).
  const why = (): "manual" | "oracle" | undefined => {
    const state = props.client.state();
    if (state.phase !== "turn") {
      return undefined;
    }
    if (state.oracle === true) {
      return "oracle";
    }
    return state.paused === true ? "manual" : undefined;
  };
  return (
    <Show when={why()} keyed>
      {(reason) => (
        <div
          data-testid="paused-banner"
          data-reason={reason}
          style="margin: 8px 12px; font: 12px system-ui; border: 1px solid #7c3aed; border-radius: 6px; padding: 6px 8px; max-width: 460px"
        >
          <div>
            <strong>
              {reason === "oracle" ? "oracle live — the turn is paused" : "turn paused"}
            </strong>{" "}
            — nothing is being added to the turn: audio isn't transcribed; shots, selections, and
            video frames are off.
          </div>
          <div style="opacity: 0.7; margin-top: 2px">
            {reason === "oracle"
              ? "what you say and show goes to the oracle instead — 🔮 (or o) leaves, and the turn comes back exactly as it was."
              : "the turn keeps everything it already holds — ⏸ (or b) resumes; send and cancel still work."}
          </div>
        </div>
      )}
    </Show>
  );
}

/**
 * The oracle's two panel surfaces (O3a): the ambient MIND strip — one line
 * answering "what is it doing right now" — shown whenever a session exists,
 * and the ledger VIEWER behind a fold, which is the oracle's trace (the intent
 * trace stays neutral by decision, so this is where its record lives).
 * Rendered only with lanes: no lanes, no session.
 */
/**
 * Where the oracle's app tools come from — one quiet line under the mind strip
 * (owner, 2026-07-30: "it doesn't have to be obnoxious").
 *
 * It exists because of the last-app rule: the surface may legitimately belong
 * to a tab the developer is not looking at, and that is precisely the state
 * that read as a bug before — the oracle insisting the app had no such tool
 * while the tools sat under a tab behind the one in view. So the OFF-VIEW case
 * is the one that speaks up (amber, and it names the app); the ordinary case
 * stays a dim single line; and holding NO app tools says so rather than
 * leaving the absence to be inferred.
 */
function ToolSourceLine(props: { lanes: ChannelLanes }) {
  const source = () => props.lanes.toolSource();
  return (
    <div
      class="aiui-oracle-source"
      data-testid="oracle-tool-source"
      data-off-view={source() !== undefined && !source()?.inView ? "" : undefined}
    >
      <Show
        when={source()}
        keyed
        fallback={<span>no app tools — the tab in view isn't an aiui app</span>}
      >
        {(from) => (
          <span>
            {from.count} app tool{from.count === 1 ? "" : "s"} from{" "}
            <strong>{from.label ?? `tab ${from.tab}`}</strong>
            {from.inView ? "" : " — not the tab in view"}
          </span>
        )}
      </Show>
    </div>
  );
}

/**
 * The oracle's panes — STANDING, not gated on the oracle being on (owner,
 * 2026-07-31).
 *
 * They used to render only while a session was live or connecting, which threw
 * away the record at the moment it became useful: you turn the oracle off and
 * the ledger of what it just did, what it cost, and what config the server
 * actually held vanishes with it. The trace viewer is the precedent — a
 * finished run is exactly when you read it.
 *
 * Nothing here needs a session to render. The lane holds ONE `OracleSession`
 * for the panel's life and its ledger accumulates across connects (`start()`
 * resets the reply line, never the entries), so the history is genuinely
 * continuous rather than a snapshot of the last connection. The params boards
 * disable their rows with a reason when nothing is open, and the mind strip
 * says "off" — both are true statements rather than absences.
 */
function OraclePanes(props: { client: IntentClient; lanes: ChannelLanes }) {
  const live = (): boolean => {
    const status = props.client.claimStatuses().oracleSession?.phase;
    return props.client.state().oracle === true || status === "active" || status === "pending";
  };
  return (
    <div class="aiui-oracle-panes" data-testid="oracle-panes" data-live={live() ? "true" : "false"}>
      {/* The block has to SAY it is the oracle's, and making the panes stand
          is what created the need: while they only appeared with a live
          session the context was obvious, but a status dot reading "off"
          above three folds could belong to anything on the panel. The folds
          name the oracle individually; the strip above them did not.
          No state here — the mind strip directly below is the one place that
          answers "what is it doing", and two of them would disagree eventually. */}
      <div class="aiui-oracle-panes-title">🔮 oracle</div>
      <OracleParkBanner session={props.lanes.oracle} />
      <OracleMind session={props.lanes.oracle} />
      <OracleUsage session={props.lanes.oracle} />
      {/* Which app's tools the oracle can see is only a live-session question;
          off, there is no session to hold them and the line would be noise. */}
      <Show when={live()}>
        <ToolSourceLine lanes={props.lanes} />
      </Show>
      <details class="aiui-pane" data-testid="oracle-ledger">
        <summary>oracle ledger</summary>
        <OracleViewer session={props.lanes.oracle} mind={false} />
      </details>
      {/* The same two knob-boards the oracle lab carries. Here because the
          panel's acoustics are the ones that matter — a laptop mic listening
          to its own speakers — and tuning against the lab would be tuning
          against a different room. */}
      <details class="aiui-pane" data-testid="oracle-realtime-params">
        <summary>realtime session params</summary>
        <OracleRealtimeParams session={props.lanes.oracle} />
      </details>
      <details class="aiui-pane" data-testid="oracle-webrtc-params">
        <summary>webrtc mic constraints</summary>
        <OracleWebRtcParams session={props.lanes.oracle} />
      </details>
    </div>
  );
}

/**
 * The panel's render tree. Emits its own `<style>`, so an entry renders exactly
 * `<PanelLayout … />` and nothing else. The decided order (owner, 2026-07-14):
 * channel first, then the target tab (CDP only), the panel (bar + pills), the
 * turn preview, the traces, and last the narration. (The debugging surfaces
 * this order clause promised would go ARE mostly gone, 2026-07-19: the raw
 * event list and the lowered-prompt echo are deleted — the rich trace pane
 * carries both jobs — and the debug pane renders only when a shell still has
 * content for it, i.e. the plain page's simulate strip.)
 */
export function PanelLayout(props: PanelLayoutProps): JSX.Element {
  return (
    <>
      <style>{PANEL_LAYOUT_STYLES}</style>
      <ChannelHeader
        port={props.port}
        phase={props.phase}
        listChannels={props.listChannels}
        onSwitch={props.onSwitch}
      />
      <Show when={props.sessionName} keyed>
        {(control) => <SessionNameChip name={control.name} rename={control.rename} />}
      </Show>
      {props.targetTab}
      <GrantBanner client={props.client} />
      <PausedBanner client={props.client} />
      <Panel
        client={props.client}
        registerBlipSink={props.registerBlipSink}
        micLevel={props.micLevel}
        linterPulse={props.lanes !== undefined ? props.lanes.linterPulse : undefined}
        lintControl={props.lanes !== undefined ? { now: props.lanes.lintNow } : undefined}
        turnHasContent={props.lanes !== undefined ? props.lanes.turnHasContent : undefined}
      />
      {/* The TURN comes first (owner, 2026-07-31) — it is what the panel is
          for, and what you are in the middle of. The oracle is the detour and
          sits after it; the prompt history is the record and sits last. */}
      <Show when={props.lanes} keyed>
        {(lanes) => <TurnPreview lanes={lanes} />}
      </Show>
      <Show when={props.lanes} keyed>
        {(lanes) => <OraclePanes client={props.client} lanes={lanes} />}
      </Show>
      <Show when={props.lanes !== undefined && props.port !== undefined}>
        <RichTracePane baseUrl={`http://127.0.0.1:${props.port}`} />
      </Show>
      <Show when={props.debug?.content !== undefined}>
        <details
          class="aiui-pane"
          data-testid="extension-debugging"
          open={props.debug?.open}
          style="opacity: 0.85"
        >
          <summary>debugging</summary>
          {props.debug?.content}
        </details>
      </Show>
      <WirePane narration={props.narration} />
    </>
  );
}
