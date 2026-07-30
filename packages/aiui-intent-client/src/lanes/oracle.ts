/**
 * oracle.ts — the panel's oracle session (O3a, docs/proposals/intent-oracle.md).
 *
 * ONE `OracleSession` is constructed with the lanes and lives as long as they
 * do; the mode engine's `oracleSession` CLAIM starts and stops it. That split
 * is deliberate: constructing costs nothing (no socket, no mic — `start()` is
 * what connects), so the UI can hold a stable reference for `OracleMind` and
 * the viewer from the first render, while the claim reconciler owns the
 * lifecycle and its status IS the connecting/live/failed truth the pill shows.
 *
 * The credential comes from the CHANNEL (`POST /intent/oracle/mint`, the intent
 * sidecar): the parent key stays in the channel process and the panel only ever
 * holds a short-lived `ek_`. A user's own pasted key still trumps it — the
 * standard chain's first source — so a panel served from a keyless channel is
 * still usable by pasting.
 *
 * The mic is NOT managed here: `setMicEnabled` rides the derived edge in
 * client.ts (talk grip ∧ ¬park ∧ ¬mute), because gating an already-open track
 * is a boolean, not a resource to acquire.
 */

import {
  cachingKeySource,
  chainKeySource,
  mintingKeySource,
  OracleSession,
  pasteKeySource,
  weaveInstructions,
  webRtcTransport,
} from "@habemus-papadum/aiui-oracle";
import type { LaneContext } from "./types";

/** What the panel oracle tells the model about where it is standing. O3a is
 * deliberately thin here: the app-tool surface (O3b) and the tab-record
 * prelude (O3d) are what make this specific. */
const PANEL_BLURB =
  "You are embedded in the aiui intent panel — the control surface a developer uses to " +
  "brief a coding agent about the web app they are building. Right now you have no tools " +
  "beyond talking: answer from what the user tells you, and say plainly when you would " +
  "need to look at something you cannot see.";

export interface OracleLanes {
  /** The session — stable for the panel's whole life; the claim connects it. */
  session: OracleSession;
  /** The claim's hooks (ClaimLaneOptions.oracle). */
  start: () => Promise<void>;
  stop: () => void;
  /** The derived mic gate's relay (IntentLanes.setOracleMic). */
  setMicEnabled: (on: boolean) => void;
}

export function createOracleLanes(ctx: LaneContext): OracleLanes {
  const { config, status, toast } = ctx;
  const session = new OracleSession({
    config: { instructions: weaveInstructions({ app: PANEL_BLURB }) },
    // The chain's order is the standard one (a pasted key TRUMPS everything),
    // with the channel's mint standing in for a deployed app's endpoint. The
    // URL is resolved per call so a channel rebind is picked up without
    // rebuilding the session.
    keySource: chainKeySource([
      pasteKeySource(),
      cachingKeySource(
        mintingKeySource("/intent/oracle/mint", {
          fetchImpl: (input, init) => {
            const port = config.port();
            // Same-origin when the channel SERVES the panel; absolute when the
            // panel is the standalone `pnpm dev` page on a Vite origin.
            const url =
              port === undefined ? String(input) : `http://127.0.0.1:${port}${String(input)}`;
            return fetch(url, init);
          },
        }),
      ),
    ]),
    transport: webRtcTransport(),
  });

  // The session's own narration rides the panel's status line and toasts — the
  // ledger keeps the full record, but a failure has to be visible without
  // opening a fold.
  session.onState((state) => {
    if (state.playbackBlocked) {
      toast("the oracle's voice is blocked until you click or press a key in this panel");
    }
  });
  session.onLedger((entry) => {
    if (entry.kind === "session") {
      status(`oracle: ${entry.phase}${entry.detail !== undefined ? ` — ${entry.detail}` : ""}`);
    } else if (entry.kind === "error") {
      toast(`oracle ${entry.source}: ${entry.message}`);
    }
  });

  return {
    session,
    // Rethrow nothing: the claim treats a rejection as `error` status, and the
    // session has already recorded the cause in its ledger (and toasted it).
    start: () => session.start(),
    stop: () => session.close(),
    setMicEnabled: (on) => {
      if (on) {
        session.resume();
      } else {
        session.park();
      }
    },
  };
}
