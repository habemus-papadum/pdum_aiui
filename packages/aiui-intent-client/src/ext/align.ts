/**
 * align.ts — the extension tier's CDP-ALIGNMENT supervisor: gathers the two
 * evidence sources (the local driver ROSTER in chrome.storage; the bound
 * channel's `/intent/cdp/info`), liveness-filters the roster, decorates
 * drivers with registry labels, derives the verdict (src/cdp-align.ts — the
 * pure half), and keeps it fresh for the panel's whole life. One writer for
 * the signal — the pill, the hello meta, and the mismatch toast all read
 * what this pushes.
 *
 * Multi-agent co-driving is a SUPPORTED workflow (owner, 2026-07-19): the
 * roster deliberately carries every live driver, and the verdict's
 * `coDrivers` is how sharing surfaces (the purple pill; the prelude's
 * heads-up to the agent). Debug-ness is NOT consulted anywhere here — a
 * debug channel is just another parallel agent; "(debug)" belongs to the
 * channel dropdown alone.
 *
 * Freshness: re-derives on every roster write (`onCdpDriversChanged` — the
 * taggers' retry beats land entries AFTER panel boot) and on a slow beat
 * (the channel's side can change: browser launched later, endpoint moved,
 * a co-driver appearing). Logs transitions under `[cdp]`; the hard-mismatch
 * escalation (toast) is the caller's, so this module stays chrome+fetch
 * only, no UI.
 */

import {
  type CdpAlignment,
  type CdpDriverInfo,
  type ChannelCdpInfo,
  deriveCdpAlignment,
  describeCdpAlignment,
} from "../cdp-align";
import { channelsVia, onCdpDriversChanged, readCdpDrivers } from "./channel";

const TAG = "[cdp]";

/** How often the evidence is re-read (roster writes also trigger a pass). */
const REFRESH_MS = 30_000;

/** The channel's `/intent/cdp/info`, shaped for the derivation. */
async function fetchChannelInfo(port: number): Promise<ChannelCdpInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/intent/cdp/info`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as {
      available?: boolean;
      browserUrl?: string;
      tagged?: boolean;
    };
    return {
      available: body.available === true,
      ...(body.browserUrl !== undefined ? { browserUrl: body.browserUrl } : {}),
      ...(body.tagged !== undefined ? { tagged: body.tagged } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Is the channel a roster entry names still alive? A fresh entry only
 * proves a recent write — the derivation must never see a dead driver
 * (cdp-align.ts's liveness contract). */
async function driverAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** "resolved-name :port" labels from the registry mirror, best-effort. */
function labelFor(
  port: number,
  mirror: Array<{ port: number; resolvedName?: string; cwd?: string }>,
) {
  const entry = mirror.find((e) => e.port === port);
  const name = entry?.resolvedName ?? entry?.cwd?.split("/").filter(Boolean).at(-1);
  return name !== undefined ? `${name} :${port}` : undefined;
}

export interface AlignmentSupervisor {
  /** The latest verdict (undefined until the first derivation lands). */
  current(): CdpAlignment | undefined;
  stop(): void;
}

/**
 * Start supervising. `onChange` fires on every TRANSITION of state or driver
 * set (not on re-affirmations), with the fresh verdict — feed it to
 * `client.setContext`.
 */
export function superviseCdpAlignment(options: {
  /** The channel this panel bound to (undefined = none found). */
  boundPort: number | undefined;
  onChange: (alignment: CdpAlignment) => void;
}): AlignmentSupervisor {
  let latest: CdpAlignment | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const evaluate = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    // The roster, liveness-filtered (the bound channel needs no probe — it
    // answered /health at boot, and its death surfaces on the session bus).
    const roster = await readCdpDrivers();
    const live: number[] = [];
    for (const entry of roster) {
      if (entry.port === options.boundPort || (await driverAlive(entry.port))) {
        live.push(entry.port);
      }
    }
    const channelInfo =
      options.boundPort !== undefined ? await fetchChannelInfo(options.boundPort) : undefined;
    // Labels come from the registry mirror — one fetch, best-effort. Asked
    // of the bound channel when there is one, else of any live driver.
    const labelSource = options.boundPort ?? live[0];
    const mirror = labelSource !== undefined ? await channelsVia(labelSource) : [];
    const drivers: CdpDriverInfo[] = live.map((port) => {
      const label = labelFor(port, mirror);
      return { port, ...(label !== undefined ? { label } : {}) };
    });
    const next = deriveCdpAlignment({ boundPort: options.boundPort, drivers, channelInfo });
    if (stopped) {
      return;
    }
    const signature = (a: CdpAlignment | undefined): string =>
      a === undefined ? "" : `${a.state}#${(a.drivers ?? []).map((d) => d.port).join(",")}`;
    if (signature(latest) !== signature(next)) {
      console.info(TAG, `alignment: ${describeCdpAlignment(next)}`);
      latest = next;
      options.onChange(next);
    } else {
      latest = next; // refresh details silently (labels, browserUrl)
    }
  };

  const beat = (): void => {
    timer = setTimeout(() => {
      void evaluate().then(beat);
    }, REFRESH_MS);
  };
  void evaluate().then(beat);
  // Roster entries land (move, vanish) at any time — the taggers retry until
  // the worker wakes; re-derive immediately on every write.
  onCdpDriversChanged(() => void evaluate());

  return {
    current: () => latest,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
