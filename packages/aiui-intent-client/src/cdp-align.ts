/**
 * cdp-align.ts — the CDP ALIGNMENT signal: does the browser this client runs
 * in match the browser the bound channel drives over CDP? (owner, 2026-07-19)
 *
 * Why it exists: the agent behind the channel may hold a Chrome DevTools MCP
 * pointed at the channel's session browser — while the intent client can be
 * running in a completely different Chrome. Nothing else makes that visible,
 * and features key off it: the user's pill, the prompt prelude's warning to
 * the agent, and (later) which tools the oracle is granted.
 *
 * The evidence, combined from both sides of the wire:
 *  - the LOCAL DRIVER ROSTER (`aiui2.cdpDriver:<port>` entries) — written
 *    into this extension's storage by each channel THROUGH the browser's own
 *    debug endpoint (cdp/tagger.ts), so an entry is self-verifying proof of
 *    who drives THIS browser. Plural on purpose: multiple agents co-driving
 *    one browser is a SUPPORTED workflow, and `coDrivers` is how it
 *    surfaces (purple pill; a heads-up sentence in the prompt prelude);
 *  - the CHANNEL's own report (`/intent/cdp/info`) — whether the bound
 *    channel has a CDP endpoint at all, and whether its tagger has landed
 *    anywhere.
 *
 * Debug-ness is deliberately NOT part of this signal: a debug channel is
 * treated as just another parallel agent (the infrastructure is unaware; the
 * channel DROPDOWN is where "(debug)" surfaces to the user).
 *
 * What is knowable, honestly: a browser cannot name its own debug port from
 *  inside (no `chrome.*` API), so "this browser has a port but nobody tags
 * it" is invisible — the states below are everything the two evidence
 * sources can distinguish. This module is pure and chrome-free: the
 * extension's supervisor (ext/align.ts) and the page entry both feed it.
 */

/** The five distinguishable states (see the table in the module doc). */
export type CdpAlignmentState =
  /** The bound channel is among this browser's drivers: the agent's
   * DevTools MCP sees THIS browser. The strongest verdict — a roster entry
   * is self-verifying. `coDrivers` may name others sharing the browser. */
  | "aligned"
  /** The roster names only OTHER live channels: this browser IS CDP-driven,
   * but not by the channel this panel is bound to. */
  | "driven-by-other"
  /** The bound channel HAS a CDP endpoint, but no roster entry here: the
   * agent's browser is not the one the user is looking at. (Whether this
   * browser has its own debug port is unknowable from inside.) */
  | "channel-drives-other"
  /** The bound channel reports no CDP endpoint: the agent has no browser at
   * all (`--aiui-no-session-browser`, `aiui serve`). Normal and calm. */
  | "channel-no-cdp"
  /** No channel bound, or the probe failed — nothing to say. */
  | "unknown";

/** One channel driving this browser, as the alignment fact carries it. */
export interface CdpDriverInfo {
  port: number;
  /** Human label ("pdum_aiui :4100"), best-effort from the registry mirror. */
  label?: string;
}

/** The structured fact — what context, the hello meta, and the trace carry. */
export interface CdpAlignment {
  state: CdpAlignmentState;
  /** The channel this client is bound to (the wire). */
  boundPort?: number;
  /** The bound channel's CDP endpoint (when it has one). */
  channelBrowserUrl?: string;
  /** Every live channel driving THIS browser (the roster), bound included
   * when aligned. */
  drivers?: CdpDriverInfo[];
  /** Drivers OTHER than the bound channel: aligned + nonempty = the shared
   * (purple) case; on driven-by-other it equals `drivers`. */
  coDrivers?: CdpDriverInfo[];
}

/** The channel's side of the evidence — `/intent/cdp/info`'s answer. */
export interface ChannelCdpInfo {
  /** The bound channel has a live CDP endpoint it can drive. */
  available: boolean;
  /** That endpoint (loopback), when available. */
  browserUrl?: string;
  /** The channel's tagger has landed its tag in SOME browser's copy of the
   * extension (absent = unknown — an older channel without the field). */
  tagged?: boolean;
}

/**
 * Derive the alignment from the two evidence sources. Pure.
 *
 * `drivers` must already be LIVENESS-FILTERED by the caller: a roster entry
 * naming a dead channel proves only history, so the supervisor drops it
 * before deriving (ext/align.ts probes `/health` per entry).
 */
export function deriveCdpAlignment(input: {
  boundPort: number | undefined;
  drivers: CdpDriverInfo[];
  channelInfo: ChannelCdpInfo | undefined;
}): CdpAlignment {
  const { boundPort, drivers, channelInfo } = input;
  if (boundPort === undefined) {
    return { state: "unknown" };
  }
  const browserUrl =
    channelInfo?.browserUrl !== undefined ? { channelBrowserUrl: channelInfo.browserUrl } : {};
  if (drivers.some((driver) => driver.port === boundPort)) {
    const coDrivers = drivers.filter((driver) => driver.port !== boundPort);
    return {
      state: "aligned",
      boundPort,
      drivers,
      ...(coDrivers.length > 0 ? { coDrivers } : {}),
      ...browserUrl,
    };
  }
  if (drivers.length > 0) {
    return { state: "driven-by-other", boundPort, drivers, coDrivers: drivers, ...browserUrl };
  }
  if (channelInfo === undefined) {
    return { state: "unknown", boundPort };
  }
  if (!channelInfo.available) {
    return { state: "channel-no-cdp", boundPort };
  }
  // The channel drives a browser and no roster entry landed here.
  // `tagged === false` (its tag landed NOWHERE yet) is the same verdict with
  // less certainty — if this IS the session browser, the tagger's retry beat
  // will flip the state to aligned within seconds; the supervisor re-derives
  // on roster writes.
  return { state: "channel-drives-other", boundPort, ...browserUrl };
}

/** Aligned AND sharing the browser with other channels — the purple case. */
export function isSharedAlignment(alignment: CdpAlignment | undefined): boolean {
  return (
    alignment?.state === "aligned" &&
    alignment.coDrivers !== undefined &&
    alignment.coDrivers.length > 0
  );
}

/** "label :port" per driver, comma-joined — tooltips and prelude share it. */
export function describeDrivers(drivers: CdpDriverInfo[]): string {
  return drivers.map((d) => d.label ?? `:${d.port}`).join(", ");
}

/** The human sentence per state — the pill tooltip and the console line
 * share it (the prompt prelude has its own agent-addressed wording,
 * channel-side in prompt-context.ts). */
export function describeCdpAlignment(alignment: CdpAlignment | undefined): string {
  switch (alignment?.state) {
    case "aligned":
      return isSharedAlignment(alignment)
        ? `aligned, SHARED — the agent's DevTools see THIS browser (channel :${alignment.boundPort}), which is also driven by ${describeDrivers(alignment.coDrivers ?? [])}`
        : `aligned — the agent's DevTools see THIS browser (channel :${alignment.boundPort})`;
    case "driven-by-other":
      return `misaligned — this browser is driven by ${describeDrivers(alignment.drivers ?? [])}, but the panel is bound to :${alignment.boundPort}`;
    case "channel-drives-other":
      return `misaligned — the agent's DevTools point at a different browser (${alignment.channelBrowserUrl ?? "its session browser"}), not this one`;
    case "channel-no-cdp":
      return "no CDP — the channel drives no browser (agent DevTools not wired)";
    default:
      return "unknown — no channel bound, or the probe failed";
  }
}
