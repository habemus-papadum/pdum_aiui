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
  chainKeySource,
  mintingKeySource,
  OracleSession,
  pasteKeySource,
  weaveInstructions,
  webRtcTransport,
} from "@habemus-papadum/aiui-oracle";
import type { IntentClient } from "../client";
import { oracleMic } from "../spec";
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
  /**
   * Bind the machine to the session, once, from `bind`. Two jobs, both needing
   * the client: apply the mic gate the moment a session finishes connecting
   * (an EDGE relay cannot gate a track that did not exist yet), and drop the
   * DESIRE when a session ends without being asked to (the ~60 minute vendor
   * cap, a network drop). Returns the unsubscribe.
   */
  attach: (client: IntentClient) => () => void;
}

export function createOracleLanes(ctx: LaneContext): OracleLanes {
  const { config, status, toast } = ctx;
  // Set by `attach` (from lanes.bind) — the machine, for the two moments that
  // need to READ state rather than be told about an edge.
  let bound: IntentClient | undefined;
  const session = new OracleSession({
    config: { instructions: weaveInstructions({ app: PANEL_BLURB }) },
    // The chain's order is the standard one (a pasted key TRUMPS everything),
    // with the channel's mint standing in for a deployed app's endpoint. The
    // URL is resolved per call so a channel rebind is picked up without
    // rebuilding the session.
    //
    // ONE FRESH CREDENTIAL PER SESSION (owner, 2026-07-30) — deliberately NOT
    // `cachingKeySource`. Caching exists for a mint that costs something: a
    // cloud function, a cold start, a metered call, where reusing one `ek_`
    // across reconnects inside its TTL is worth the staleness. Here the mint is
    // a LOOPBACK round trip to our own channel, so the trade inverts — a fresh
    // secret per `start()` is simpler to reason about (every session's
    // credential is minted for it, nothing outlives the conversation it opened)
    // and costs a few milliseconds nobody can feel next to the WebRTC
    // offer/answer.
    keySource:
      config.oracleKeySource ??
      chainKeySource([
        pasteKeySource(),
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
      ]),
    transport: config.oracleTransport ?? webRtcTransport(),
  });

  /** The machine's gate, applied to the live track. Closed when nothing is
   * bound yet — a session cannot be hearing for a client that does not exist. */
  const applyMicGate = (): void => {
    const on = bound !== undefined && oracleMic(bound.state());
    if (on) {
      session.resume();
    } else {
      session.park();
    }
  };

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
    start: async () => {
      // Defensive close before a retry. `OracleSession.start` no-ops unless the
      // status is idle|closed, and a FAILED start leaves it at `error` — while
      // the claims reconciler never calls `release` for an acquire that threw
      // (nothing was held), so nothing else returns it to a startable state.
      // Without this, pressing 🔮 again after a keyless mint was a silent
      // no-op: the cap lit, the pill error, and nothing happening.
      if (session.state().status === "error") {
        session.close();
      }
      await session.start();
      // …and TRANSLATE a failure into a rejection. `start` is chromeless by
      // design: it records the cause in its own ledger and sets `error`, but
      // it RESOLVES either way, so an acquire that merely awaited it would
      // report `active` over a session that never connected (found by test —
      // the claim's honesty is the whole reason it is a claim). The ledger
      // still holds the real cause; this is what makes the pill agree with it.
      const state = session.state();
      if (state.status === "error") {
        const last = [...session.ledger()].reverse().find((entry) => entry.kind === "error");
        throw new Error(
          last?.kind === "error" ? `${last.source}: ${last.message}` : "the oracle failed to start",
        );
      }
      // Apply the gate to the track that now exists. The client relays every
      // EDGE of `oracleMic`, but a connect is not an edge — and the vendor's
      // mic track comes up ENABLED — so a session opened with the grip off
      // would sit there hot (found by test, against the whole "it never
      // listens on activation" guarantee). The same predicate, at the one
      // moment an edge cannot cover; a grip already on comes up hearing.
      applyMicGate();
    },
    stop: () => session.close(),
    setMicEnabled: (on) => {
      if (on) {
        session.resume();
      } else {
        session.park();
      }
    },
    attach: (client) => {
      bound = client;
      // A session can END without anyone asking: the vendor caps a session
      // (~60 minutes), the network drops, the data channel closes. The DESIRE
      // would otherwise stand over a dead session — a lit cap and an `active`
      // pill describing nothing, which is the exact failure the claim exists
      // to prevent. So an unasked-for close drops the desire and says why.
      //
      // Deliberate closes are excluded by ordering, not by a flag: a dispatch
      // commits the region BEFORE the reconciler releases, so by the time
      // `close()` records this entry the region is already false.
      const off = session.onLedger((entry) => {
        if (entry.kind !== "session" || entry.phase !== "closed") {
          return;
        }
        if (client.state().oracle !== true) {
          return;
        }
        client.dispatch("oracle");
        toast(
          `the oracle session ended${entry.detail !== undefined ? ` (${entry.detail})` : ""} — ` +
            "sessions are capped at about an hour; 🔮 starts a fresh one",
        );
      });
      return () => {
        bound = undefined;
        off();
      };
    },
  };
}
