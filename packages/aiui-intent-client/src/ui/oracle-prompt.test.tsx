// @vitest-environment jsdom
/**
 * oracle-prompt.test.tsx — the startup-prompt rows as the panel renders them:
 * collapsed by default (the whole point — the text is dense), and a mid-session
 * re-weave APPENDS a row without disturbing one the reader had opened.
 *
 * The session is a stub over the two seams the component uses (`ledger` +
 * `onLedger`): a real one would need a transport, a credential and a vendor to
 * ack anything, none of which this behavior depends on.
 */
import type { LedgerBody, LedgerEntry, OracleSession } from "@habemus-papadum/aiui-oracle";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { OraclePromptWeaves } from "./oracle-prompt";

let seq = 0;
const entryOf = (body: LedgerBody): LedgerEntry => ({ at: 1_000 + seq, seq: ++seq, ...body });

interface FakeSession {
  session: OracleSession;
  record: (body: LedgerBody) => void;
}

function fakeSession(initial: LedgerBody[] = []): FakeSession {
  const entries: LedgerEntry[] = initial.map(entryOf);
  const listeners = new Set<(entry: LedgerEntry) => void>();
  const session = {
    ledger: () => entries,
    onLedger: (listener: (entry: LedgerEntry) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as OracleSession;
  return {
    session,
    record: (body) => {
      const full = entryOf(body);
      entries.push(full);
      for (const listener of listeners) {
        listener(full);
      }
    },
  };
}

const PERSONA = "You are the oracle.";
const WITH_TAB = `${PERSONA}\n\nThe page the developer is looking at right now:\n<tab url="x"/>`;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function mount(session: OracleSession): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  dispose = render(() => <OraclePromptWeaves session={session} />, root);
  return root;
}

const rows = (root: HTMLElement): HTMLDetailsElement[] => [
  ...root.querySelectorAll<HTMLDetailsElement>("[data-testid=oracle-prompt]"),
];

describe("the panel's startup-prompt rows", () => {
  it("renders nothing until a session has been configured", () => {
    const root = mount(fakeSession([{ kind: "session", phase: "connecting" }]).session);
    expect(root.querySelector("[data-testid=oracle-prompts]")).toBeNull();
  });

  it("shows the startup prompt COLLAPSED, one line naming its size", async () => {
    const fake = fakeSession([{ kind: "session", phase: "connecting" }]);
    const root = mount(fake.session);

    fake.record({ kind: "config", sent: { instructions: PERSONA }, effective: {} });
    await flush();

    const row = rows(root)[0];
    expect(row).toBeDefined();
    expect(row.open).toBe(false); // dense text does not open itself
    expect(row.getAttribute("data-kind")).toBe("startup");
    expect(row.querySelector("summary")?.textContent).toBe(
      `startup prompt · ${PERSONA.length} chars`,
    );
    // …and the whole weave is there to be read on expand.
    expect(row.querySelector("pre")?.textContent).toBe(PERSONA);
  });

  it("appends a re-weave and leaves an opened row open", async () => {
    const fake = fakeSession([{ kind: "session", phase: "connecting" }]);
    const root = mount(fake.session);
    fake.record({ kind: "config", sent: { instructions: PERSONA }, effective: {} });
    await flush();

    rows(root)[0].open = true; // the reader opens the startup prompt

    // A tab change re-weaves mid-session (applyPrelude), and a tools-only
    // update rides in between — that one is not a weave.
    fake.record({ kind: "config", sent: { tools: [] }, effective: {} });
    fake.record({ kind: "config", sent: { instructions: WITH_TAB }, effective: {} });
    await flush();

    const after = rows(root);
    expect(after.map((row) => row.getAttribute("data-kind"))).toEqual(["startup", "re-woven"]);
    expect(after[0].open).toBe(true); // the row survived the append, expanded
    expect(after[1].open).toBe(false);
    expect(after[1].querySelector("pre")?.textContent).toBe(WITH_TAB);
  });
});
