// @vitest-environment jsdom
/**
 * page-script.test.ts — the EXECUTION pin for `buildPageScript()`'s output.
 * cdp-bus.test.ts drives the bus over a scripted socket and only checks that the
 * injected STRING mentions `__aiuiIntentPage`; nothing there RUNS the bootstrap.
 * This file evaluates it for real (`new Function`, the sidecar.test.ts / key-
 * layer-parity technique) and pins the page-side contract every split step must
 * preserve: the hello on the binding, the capability `handle` answers, the
 * adopt-on-same-version handover (one hello, no doubled listeners), the
 * merge-not-clobber install, and the driver-liveness heartbeat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPageScript } from "./page-script";

interface Report {
  kind: string;
  [key: string]: unknown;
}

interface Page {
  v?: string;
  adopt?: () => void;
  hello?: () => void;
  handle: (capability: string, payload: unknown) => unknown;
  mountPencil?: () => unknown;
}

const asWindow = () =>
  window as unknown as {
    __aiuiIntentReport?: (json: string) => void;
    __aiuiIntentPage?: Page;
  };

/** Install a fresh report sink and run the built bootstrap exactly as the page
 * does (the IIFE evaluated verbatim). Returns the installed page handle. */
function evaluateBootstrap(reports: Report[]): Page {
  asWindow().__aiuiIntentReport = (json) => reports.push(JSON.parse(json) as Report);
  new Function(buildPageScript())();
  const page = asWindow().__aiuiIntentPage;
  if (page === undefined) {
    throw new Error("the bootstrap did not install __aiuiIntentPage");
  }
  return page;
}

const hellos = (reports: Report[]) => reports.filter((r) => r.kind === "hello");
const ringEl = () => document.getElementById("__aiui-intent-ring");

afterEach(() => {
  vi.useRealTimers();
  const w = asWindow();
  w.__aiuiIntentReport = undefined;
  w.__aiuiIntentPage = undefined;
  // Surfaces from one test's evaluation must not leak into the next's DOM asserts.
  document.getElementById("__aiui-intent-ring")?.remove();
  document.getElementById("__aiui-intent-ring-hint")?.remove();
  document.getElementById("__aiui-intent-region")?.remove();
});

describe("buildPageScript() output, evaluated as the page runs it", () => {
  it("says hello on the __aiuiIntentReport binding the moment it installs", () => {
    vi.useFakeTimers(); // freeze the tools poll / driver-watch intervals
    const reports: Report[] = [];
    evaluateBootstrap(reports);

    const hello = hellos(reports)[0];
    expect(hello).toMatchObject({
      kind: "hello",
      url: expect.any(String),
      title: expect.any(String),
      visible: expect.any(Boolean),
      focused: expect.any(Boolean),
      aiui: false, // no window.__AIUI__ in a bare jsdom page
    });
  });

  it("answers the capability handle with each capability's declared reply shape", () => {
    vi.useFakeTimers();
    const reports: Report[] = [];
    const page = evaluateBootstrap(reports);

    expect(page.handle("heartbeat", { session: "boot-1" })).toEqual({ ok: true });
    expect(page.handle("ring", { on: true, turnTone: false, hollow: false, hint: "" })).toEqual({
      ok: true,
    });
    // The CDP tier's selection is text-only; a bare page has no selection → null.
    expect(page.handle("selection", undefined)).toBeNull();
    // `size` answers the frame plane with no mounted surface — a window fact.
    expect(page.handle("pencil", { op: "size" })).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });

  it("re-evaluating the SAME version adopts: exactly one new hello, no new listeners", () => {
    vi.useFakeTimers();
    const reports: Report[] = [];
    evaluateBootstrap(reports); // first install: registers listeners + hellos
    expect(hellos(reports).length).toBeGreaterThanOrEqual(1);

    // Spy AFTER the first install so only the SECOND evaluation's registrations
    // are counted. A reloaded/second panel re-attaches to this live document and
    // re-runs the identical bootstrap string; the install guard must hand the
    // document over via adopt() — re-announce once, add no listeners — never a
    // full reinstall that would double every listener (found live, Phase 3).
    const docSpy = vi.spyOn(document, "addEventListener");
    const winSpy = vi.spyOn(window, "addEventListener");
    const before = reports.length;
    new Function(buildPageScript())(); // same sources → same fingerprint → adopt path

    expect(hellos(reports.slice(before))).toHaveLength(1);
    expect(docSpy).not.toHaveBeenCalled();
    expect(winSpy).not.toHaveBeenCalled();
    docSpy.mockRestore();
    winSpy.mockRestore();
  });

  it("MERGES onto a pre-existing page global carrying mountPencil (never clobbers)", () => {
    vi.useFakeTimers();
    const reports: Report[] = [];
    // The bundle landed first: a global already carrying the surface's exports
    // (the near side of the sidecar.test.ts two-writer contract — clobbering it
    // took down pencil, region, AND the heartbeat, live, 2026-07-17).
    let engaged = 0;
    const preexisting = {
      mountPencil: () => ({
        engage: () => {
          engaged++;
        },
        disengage: () => {},
        setFade: () => {},
        clear: () => {},
        undo: () => {},
        remoteBegin: () => {},
        remotePoint: () => {},
        remoteEnd: () => {},
        remoteCancel: () => {},
      }),
      locateComponents: () => [],
    };
    asWindow().__aiuiIntentPage = preexisting as unknown as Page;

    const page = evaluateBootstrap(reports);
    // Same OBJECT — references the bundle holds stay valid.
    expect(page).toBe(preexisting as unknown as Page);
    // The page-script's own surface arrived BESIDE the bundle's exports.
    expect(typeof page.handle).toBe("function");
    expect(typeof page.adopt).toBe("function");
    expect(typeof page.mountPencil).toBe("function");
    // …and the merged surface is functional: engage reaches the bundle's mount.
    expect(page.handle("pencil", { op: "engage", fadeSec: 0 })).toEqual({ ok: true });
    expect(engaged).toBe(1);
  });

  it("a steady driver's heartbeats never drop its assertions", () => {
    vi.useFakeTimers();
    const reports: Report[] = [];
    const page = evaluateBootstrap(reports);
    page.handle("ring", { on: true, turnTone: false, hollow: false, hint: "" });
    expect(ringEl()).not.toBeNull();

    // The first beat seeds the driver id; repeating the SAME id is no change, so
    // a live, steady driver never loses the assertions it is beating for.
    page.handle("heartbeat", { session: "boot-1" });
    page.handle("heartbeat", { session: "boot-1" });
    expect(ringEl()).not.toBeNull();
  });

  it("a beat naming a DIFFERENT driver soft-resets — '' counts as a session (S1, cf2072f)", () => {
    vi.useFakeTimers();
    const reports: Report[] = [];
    const page = evaluateBootstrap(reports);
    page.handle("ring", { on: true, turnTone: false, hollow: false, hint: "" });

    // '' seeds the change detector as a real session — the sanctioned S1 rule
    // ("'' counts as a driver session", commit cf2072f), which OVERRODE the
    // original split plan's '' → undefined mapping. So the FIRST beat only seeds
    // (no change yet)…
    page.handle("heartbeat", { session: "" });
    expect(ringEl()).not.toBeNull();
    // …and a later, different (real) session reads as a driver HANDOVER: a soft
    // reset that drops the client's assertions (pencil STROKES, not asserted
    // here, deliberately survive). This is the actual, intended contract.
    page.handle("heartbeat", { session: "real-driver" });
    expect(ringEl()).toBeNull();
  });
});
