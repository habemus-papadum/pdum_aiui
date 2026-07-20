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

import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { IntentClient } from "../client";
import type { ChannelLanes } from "../lanes";
import { CHANNEL_HEADER_STYLES, ChannelHeader, type ChannelListing } from "./channel-header";
import { Panel } from "./panel";
import { PANES_STYLES } from "./panes";
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
  TARGET_TAB_STYLES;

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
          talk, text, selection, and pencil work without it; shots and video need it.
        </div>
      </div>
    </Show>
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
      {props.targetTab}
      <GrantBanner client={props.client} />
      <Panel
        client={props.client}
        registerBlipSink={props.registerBlipSink}
        micLevel={props.micLevel}
        linterPulse={props.lanes !== undefined ? props.lanes.linterPulse : undefined}
        lintControl={props.lanes !== undefined ? { now: props.lanes.lintNow } : undefined}
      />
      <Show when={props.lanes} keyed>
        {(lanes) => <TurnPreview lanes={lanes} />}
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
