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

import { renderTabRecord } from "@habemus-papadum/aiui-lowering-pipeline";
import {
  chainKeySource,
  mintingKeySource,
  OracleSession,
  type OracleTool,
  pasteKeySource,
  weaveInstructions,
  webRtcTransport,
} from "@habemus-papadum/aiui-oracle";
import { createEffect, createRoot } from "solid-js";
import type { IntentClient } from "../client";
import { oracleFileTools, oraclePageTools, oraclePanelTools } from "../config";
import { createPageTools, type PageToolsRegistry } from "../page-tools";
import { oracleMic } from "../spec";
import { fileTools, panelTools } from "./oracle-tools";
import type { LaneContext } from "./types";

/** What the panel oracle tells the model about where it is standing. Kept
 * GENERIC about which tools exist — the `tools` array is the single source of
 * truth, and a prompt naming an absent tool makes the model invent one (the
 * documented vendor failure mode the oracle's own persona is built around).
 * The tab-record prelude (O3d) is what will make this specific. */
const PANEL_BLURB =
  "You are embedded in the aiui intent panel — the control surface a developer uses to " +
  "brief a coding agent about the web app they are building. When the developer's app is " +
  "in view and exposes tools, they are the app's own controls: use them to inspect and " +
  "drive it, and say plainly when something asked for has no tool.";

/**
 * A page tool's name, sanitized for the vendor (`[a-zA-Z0-9_-]{1,64}`) and
 * namespace-prefixed when more than one namespace is registered. Mirrors the
 * rule in the oracle package's own `toolsFromAiuiRegistry` — the projection
 * there reads the LOCAL window, which in the panel is the wrong document, so
 * this is the same rule applied to descriptors that arrived over the page
 * transport instead.
 */
function vendorToolName(prefix: string, name: string): string {
  return `${prefix}${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** Project the tab's registered descriptors into oracle tools that CALL back
 * through the page transport. Pure over its inputs — the registry and the tab
 * are the only state. */
export function oracleToolsForTab(
  registry: PageToolsRegistry,
  tab: number | undefined,
): OracleTool[] {
  if (tab === undefined) {
    return [];
  }
  const namespaces = registry.toolsFor(tab);
  const prefixed = namespaces.length > 1;
  return namespaces.flatMap((registration) =>
    registration.tools.map((tool) => ({
      name: vendorToolName(prefixed ? `${registration.ns}_` : "", tool.name),
      description: tool.description,
      parameters: tool.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      // The call goes to the tab the projection was built FOR, not to whatever
      // tab is in view when the model finally calls: a tool the oracle was
      // handed for one page must never fire into another (a switch re-projects
      // and the stale tool goes away with it).
      execute: (args: Record<string, unknown>) =>
        registry.call(tab, registration.ns, tool.name, args),
    })),
  );
}

export interface OracleLanes {
  /** The session — stable for the panel's whole life; the claim connects it. */
  session: OracleSession;
  /** The page-tools registry the surface is projected from (O3b). */
  pageTools: PageToolsRegistry;
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

/** Only the seams a session needs — NARROWER than LaneContext on purpose: the
 * context carries the session itself (O3d's contribution fork reads it), so
 * taking the whole thing here would be circular. */
type OracleLaneContext = Pick<LaneContext, "config" | "host" | "status" | "toast">;

export function createOracleLanes(ctx: OracleLaneContext): OracleLanes {
  const { config, host, status, toast } = ctx;
  // Set by `attach` (from lanes.bind) — the machine, for the moments that need
  // to READ state rather than be told about an edge.
  let bound: IntentClient | undefined;
  // The panel's own view of the driven page's tools — a second, independent
  // consumer of the `pageTools` stream that tools-link already reads (see
  // page-tools.ts on why they are not layered).
  const pageTools = config.pageTools ?? createPageTools({ host });
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

  /**
   * Tell the session what page the human is looking at (O3d), by re-weaving
   * the instructions with the tab record the lowering renders — `renderTabRecord`
   * verbatim, so the oracle reads the same `<tab …/>` shape the agent behind
   * the channel does, and the human's "this page" means the same thing to
   * both. Best-effort: a host with no `tabMeta` (the fake tier) simply gets
   * the standing blurb.
   */
  const applyPrelude = async (): Promise<void> => {
    const meta = await config.tabMeta?.().catch(() => undefined);
    const url = typeof meta?.url === "string" ? meta.url : undefined;
    if (url === undefined) {
      return;
    }
    const record = renderTabRecord({
      url,
      ...(typeof meta?.title === "string" ? { title: meta.title } : {}),
    });
    session.setInstructions(
      weaveInstructions({
        app: PANEL_BLURB,
        extra: `The page the developer is looking at right now:\n${record}`,
      }),
    );
  };

  /**
   * The app's tools, projected onto the live session (O3b). Called on every
   * input change AND once at connect — the same two-moment rule the mic gate
   * needed, and for the same reason: a connect is not a change, so an
   * edge-driven projection alone would hand a freshly-opened session nothing.
   *
   * `setTools` is wholesale (the vendor's semantics) and no-ops the wire with
   * no session open, so this is safe to call whenever and cheap when idle.
   * The toggle off means an EMPTY surface, not a stale one.
   */
  const applyTools = (): void => {
    const tab = bound?.context().activeTab;
    const tools: OracleTool[] = [];
    if (oraclePageTools.get() === true) {
      tools.push(...oracleToolsForTab(pageTools, tab));
    }
    if (oraclePanelTools.get() === true && bound !== undefined) {
      tools.push(...panelTools(bound));
    }
    if (oracleFileTools.get() === true) {
      tools.push(...fileTools({ port: config.port }));
    }
    // Three groups, one wholesale surface (the vendor's semantics). A group's
    // toggle off means its tools are ABSENT, never stale — and the persona
    // stays generic about what exists, because the array is the single source
    // of truth (the documented vendor failure mode: a prompt naming an absent
    // tool makes the model invent one).
    session.setTools(tools);
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
    pageTools,
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
      // …and the tool surface, for the same reason: the session was
      // constructed empty and a connect is not a change (O3b).
      applyTools();
      // …and WHERE it is standing (O3d). Once per session rather than on
      // every contributed item: a selection's own `<selection-metadata>`
      // carries its tab, but a session that has been told the page up front
      // can talk about it before anything is contributed at all.
      await applyPrelude();
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
      // Live re-projection (O3b): the surface follows the tab in view and the
      // page's own registry, so a navigation, a tab switch, or an app
      // registering a tool at runtime all swap what the model holds MID-SESSION
      // — which the vendor supports and the package was built for. Solid's
      // TWO-ARG effect shape (the one-arg form throws MISSING_EFFECT_FN — the
      // repo footgun), everything read in the compute so nothing warns
      // STRICT_READ_UNTRACKED.
      const disposeTools = createRoot((dispose) => {
        createEffect(
          () => ({
            page: oraclePageTools.get() === true,
            panel: oraclePanelTools.get() === true,
            files: oracleFileTools.get() === true,
            tab: client.context().activeTab,
            live: client.state().oracle === true,
          }),
          () => applyTools(),
        );
        return dispose;
      });
      // The registry is a plain callback, not a signal — an app registering a
      // tool after load reaches us here.
      const offRegistry = pageTools.onChange(() => applyTools());
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
        offRegistry();
        disposeTools();
        pageTools.dispose();
      };
    },
  };
}
