/**
 * oracle-prompt-fold.test.ts — the startup-prompt rows' two rules, over
 * hand-built ledgers: an unchanged re-send is not a weave, and a reconnect
 * opens a new startup prompt even when the text is the one the last connection
 * ended on.
 */

import type { LedgerBody, LedgerEntry } from "@habemus-papadum/aiui-oracle";
import { describe, expect, it } from "vitest";
import { promptWeaves, weaveSummary } from "./oracle-prompt-fold";

let seq = 0;
const entry = (body: LedgerBody): LedgerEntry => ({ at: 1_000 + seq, seq: ++seq, ...body });

/** What `sendSessionUpdate` records once the vendor acks it. */
const config = (sent: Record<string, unknown>): LedgerEntry =>
  entry({ kind: "config", sent, effective: sent, drift: [] });

const PERSONA = "You are the oracle.\n\nAbout this app: the intent panel.";
const WITH_TAB = `${PERSONA}\n\nThe page the developer is looking at right now:\n<tab url="x"/>`;

describe("promptWeaves", () => {
  it("reads the connect weave as the startup prompt and the tab prelude as a re-weave", () => {
    // The panel's real opening sequence: connect sends the whole updatable
    // session, then `applyPrelude` re-weaves with the tab record (oracle.ts).
    const weaves = promptWeaves([
      entry({ kind: "session", phase: "connecting", detail: "webrtc · mint" }),
      config({ instructions: PERSONA, tools: [] }),
      entry({ kind: "session", phase: "live" }),
      config({ instructions: WITH_TAB }),
    ]);

    expect(weaves.map((weave) => weave.kind)).toEqual(["startup", "re-woven"]);
    expect(weaves[0].text).toBe(PERSONA);
    expect(weaves[1].text).toBe(WITH_TAB);
    // The seq is the ledger anchor — the row's key, and where it happened.
    expect(weaves[0].seq).toBeLessThan(weaves[1].seq);
  });

  it("ignores config acks that carried no instructions (a tools-only update)", () => {
    const weaves = promptWeaves([
      entry({ kind: "session", phase: "connecting" }),
      config({ instructions: PERSONA }),
      config({ tools: [{ name: "set_freq" }] }), // setTools sends tools alone
      entry({ kind: "said", responseId: "r1", text: "done" }),
    ]);

    expect(weaves).toHaveLength(1);
  });

  it("does not repeat an unchanged prompt — a whole-session re-send is not a weave", () => {
    // `setSessionParam` puts the WHOLE updatable session on the wire, so every
    // slider drag acks another config entry carrying the same instructions.
    const weaves = promptWeaves([
      entry({ kind: "session", phase: "connecting" }),
      config({ instructions: PERSONA }),
      config({ instructions: PERSONA, audio: { input: {} } }),
      config({ instructions: PERSONA, audio: { input: {} } }),
    ]);

    expect(weaves).toHaveLength(1);
    expect(weaves[0].kind).toBe("startup");
  });

  it("gives each connection its own startup prompt, identical text included", () => {
    // The lane holds ONE session for the panel's life and its ledger
    // accumulates across connects, so "what this connection started with" has
    // to survive a reconnect that changed nothing.
    const weaves = promptWeaves([
      entry({ kind: "session", phase: "connecting" }),
      config({ instructions: PERSONA }),
      config({ instructions: WITH_TAB }),
      entry({ kind: "session", phase: "closed", detail: "session expired" }),
      entry({ kind: "session", phase: "connecting" }),
      config({ instructions: WITH_TAB }),
    ]);

    expect(weaves.map((weave) => weave.kind)).toEqual(["startup", "re-woven", "startup"]);
    expect(weaves[2].text).toBe(WITH_TAB);
  });

  it("stays append-only as the ledger grows — earlier rows never change", () => {
    const opening: LedgerEntry[] = [
      entry({ kind: "session", phase: "connecting" }),
      config({ instructions: PERSONA }),
    ];
    const first = promptWeaves(opening);
    const later = promptWeaves([...opening, config({ instructions: WITH_TAB })]);

    expect(later.slice(0, first.length)).toEqual(first);
  });
});

describe("weaveSummary", () => {
  it("says what the row is and how big it is — the reason it rides collapsed", () => {
    expect(weaveSummary({ seq: 2, at: 0, text: "abcde", kind: "startup" })).toBe(
      "startup prompt · 5 chars",
    );
    expect(weaveSummary({ seq: 9, at: 0, text: "abc", kind: "re-woven" })).toBe(
      "prompt re-woven · 3 chars",
    );
  });
});
