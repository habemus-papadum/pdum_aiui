// @vitest-environment jsdom
/**
 * key-layer-parity.test.ts — the in-turn wholesale key layer is one of the two
 * page surfaces deliberately NOT collapsed (the code-review pass-2 S1 mirrors
 * note, git history — guarded): the CDP bootstrap listens on
 * `document` with `stopPropagation`, the MV3 content script on `window` with
 * `stopImmediatePropagation`. That divergence stays until it is ruled
 * deliberate or accidental. Until then, this pins the SHARED surface — both
 * tiers forward the same key reports and prevent the default on the same events
 * — so a change to one side that drifts the observable stream fails here.
 *
 * The one thing this test deliberately does NOT assert is the listener TARGET
 * (window vs document) and the stop-function (immediate vs not) — the two
 * documented, load-bearing differences. Both tiers are driven so their capture
 * listeners fire for an event dispatched on `document.body`, which reaches
 * `window` and `document` alike.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPageScript } from "../cdp/page-script";
import { PAGE_ADDRESS } from "../ext/protocol";

interface KeyReport {
  key: string;
  phase: string;
  repeat: boolean;
}

/** The identical sequence both tiers must forward the same way: a plain
 * down/up, a repeat, a meta-chord (which stays the browser's — no report, no
 * preventDefault), and a key born in a page INPUT (the C0 typing-target rule:
 * the field keeps it — no report, no preventDefault, both tiers). */
const SEQUENCE: ReadonlyArray<{
  type: "keydown" | "keyup";
  init: KeyboardEventInit;
  target?: "input";
}> = [
  { type: "keydown", init: { key: "s", cancelable: true, bubbles: true } },
  { type: "keyup", init: { key: "s", cancelable: true, bubbles: true } },
  { type: "keydown", init: { key: "s", repeat: true, cancelable: true, bubbles: true } },
  { type: "keydown", init: { key: "l", metaKey: true, cancelable: true, bubbles: true } },
  { type: "keydown", init: { key: "h", cancelable: true, bubbles: true }, target: "input" },
];

/** Dispatch the sequence on `document.body` (its capture path is window →
 * document → body, so both tiers' capture listeners fire) — or on a page
 * input for the typing-target steps — and return each event's
 * defaultPrevented. */
function driveSequence(): boolean[] {
  const input = document.createElement("input");
  document.body.append(input);
  const prevented: boolean[] = [];
  for (const step of SEQUENCE) {
    const event = new KeyboardEvent(step.type, step.init);
    (step.target === "input" ? input : document.body).dispatchEvent(event);
    prevented.push(event.defaultPrevented);
  }
  input.remove();
  return prevented;
}

afterEach(() => {
  vi.useRealTimers();
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
  vi.resetModules();
});

describe("in-turn key layer: CDP and MV3 forward the same stream", () => {
  it("forwards identical key reports and prevents the default on identical events", async () => {
    // Fake timers freeze the bootstrap's driver-watch interval and tool poll —
    // neither is needed here, and nothing should linger past the test.
    vi.useFakeTimers();

    // ── CDP tier: evaluate the injectable bootstrap exactly as the CdpBus does,
    // then drive keylayer through its capability surface.
    const cdpReports: KeyReport[] = [];
    (window as unknown as { __aiuiIntentReport?: (s: string) => void }).__aiuiIntentReport = (
      json,
    ) => {
      const r = JSON.parse(json);
      if (r.kind === "key") {
        cdpReports.push({ key: r.key, phase: r.phase, repeat: r.repeat });
      }
    };
    // Execute the IIFE the builder produces (the page runs this verbatim).
    new Function(buildPageScript())();
    const page = (
      window as unknown as { __aiuiIntentPage: { handle: (c: string, p: unknown) => unknown } }
    ).__aiuiIntentPage;
    page.handle("keylayer", { capture: true });
    const cdpPrevented = driveSequence();
    page.handle("keylayer", { capture: false }); // remove the document listeners

    // ── MV3 tier: import the content script with a stubbed `chrome`, then drive
    // keylayer through the relay exactly as its handler receives it.
    const relayListeners: Array<
      (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => void
    > = [];
    const mv3Reports: KeyReport[] = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: (fn: (m: unknown, s: unknown, r: (x: unknown) => void) => void) =>
            relayListeners.push(fn),
          removeListener: () => {},
        },
        sendMessage: (m: {
          aiuiIntentReport?: number;
          report?: { kind: string; key: string; phase: string; repeat: boolean };
        }) => {
          if (m?.aiuiIntentReport === 1 && m.report?.kind === "key") {
            mv3Reports.push({ key: m.report.key, phase: m.report.phase, repeat: m.report.repeat });
          }
          return Promise.resolve();
        },
        lastError: undefined,
      },
    };
    await import("../ext/content");

    const relay = (capture: boolean): void => {
      const envelope = { aiui: 1, to: PAGE_ADDRESS, cmd: "keylayer", payload: { capture } };
      for (const listener of relayListeners) {
        listener(envelope, {}, () => {});
      }
    };
    relay(true);
    const mv3Prevented = driveSequence();
    relay(false); // remove the window listeners

    // The shared surface: same reports (meta-chord AND the input-born key
    // excluded on both — the C0 typing-target rule), same preventDefault
    // verdicts — the window-vs-document target and the stop-function are the
    // documented, deliberately excluded differences.
    expect(cdpReports).toEqual([
      { key: "s", phase: "down", repeat: false },
      { key: "s", phase: "up", repeat: false },
      { key: "s", phase: "down", repeat: true },
    ]);
    expect(mv3Reports).toEqual(cdpReports);
    expect(cdpPrevented).toEqual([true, true, true, false, false]);
    expect(mv3Prevented).toEqual(cdpPrevented);

    // ── The SELECTIVE claim (C3′): while armed the payload names the claimed
    // set — a listed key forwards + prevents; everything else stays the
    // page's, identically in both tiers.
    cdpReports.length = 0;
    page.handle("keylayer", { capture: true, keys: ["h", "Enter"] });
    const cdpSelective = driveSequence(); // 's' is NOT in the set
    page.handle("keylayer", { capture: false });

    mv3Reports.length = 0;
    const relaySelective = { aiui: 1, to: PAGE_ADDRESS, cmd: "keylayer" as const };
    for (const listener of relayListeners) {
      listener(
        { ...relaySelective, payload: { capture: true, keys: ["h", "Enter"] } },
        {},
        () => {},
      );
    }
    const mv3Selective = driveSequence();
    relay(false);

    expect(cdpReports).toEqual([]); // 's' unclaimed — the page kept every event
    expect(mv3Reports).toEqual(cdpReports);
    expect(cdpSelective).toEqual([false, false, false, false, false]);
    expect(mv3Selective).toEqual(cdpSelective);
  });
});
