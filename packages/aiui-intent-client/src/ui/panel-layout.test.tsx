// @vitest-environment jsdom
/**
 * panel-layout.test.tsx — the shared layout's contract, the one both entries
 * (ui/main.tsx and ext/panel.tsx) now render. Locks what makes them identical:
 * the always-present shell, the lanes-gated panes, and the two slots the shells
 * fill differently. The lanes-ABSENT case is exactly the fake (offline) tier
 * whose look confused the two-servings investigation.
 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { createIntentClient, type IntentLanes } from "../client";
import { fakeBus } from "../fake-bus";
import { PanelLayout, type PanelLayoutProps } from "./panel-layout";
import type { Narration } from "./shell";

const noopLanes: IntentLanes = {
  openTurn: () => {},
  sendTurn: () => {},
  cancelTurn: () => {},
  takeShot: () => {},
  addSelection: () => {},
  clearInk: () => {},
  clearPencil: () => {},
  startTalk: () => {},
  stopTalk: () => {},
  setMicMuted: () => {},
};

function makeNarration(): Narration {
  const [statusLine, setStatusLine] = createSignal("");
  const [toastLine, setToastLine] = createSignal<string | undefined>(undefined);
  const [loweredPrompt, setLoweredPrompt] = createSignal<string | undefined>(undefined);
  return {
    statusLine,
    setStatusLine,
    toastLine,
    toast: (message) => setToastLine(message),
    loweredPrompt,
    setLoweredPrompt,
  };
}

let dispose: (() => void) | undefined;

function mount(extra: Partial<PanelLayoutProps>): HTMLElement {
  const client = createIntentClient({ host: fakeBus({ activeTab: 1 }), lanes: noopLanes });
  const root = document.createElement("div");
  document.body.appendChild(root);
  dispose = render(
    () => (
      <PanelLayout
        port={undefined}
        phase={() => "closed"}
        listChannels={async () => []}
        onSwitch={() => {}}
        client={client}
        narration={makeNarration()}
        {...extra}
      />
    ),
    root,
  );
  return root;
}

describe("PanelLayout", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = "";
  });

  it("renders the shared shell and gates the lanes-only panes (the fake tier)", () => {
    const root = mount({
      lanes: undefined,
      targetTab: <div data-testid="tt-marker" />,
      debug: { open: true, content: <div data-testid="dbg-marker" /> },
    });

    // Always present, in every tier and both entries:
    expect(root.querySelector("[data-testid=channel-header]")).not.toBeNull();
    const debug = root.querySelector<HTMLDetailsElement>("[data-testid=extension-debugging]");
    expect(debug).not.toBeNull();
    expect(debug?.open).toBe(true); // debug.open honored

    // Both slots render their shell-specific content:
    expect(root.querySelector("[data-testid=tt-marker]")).not.toBeNull();
    expect(root.querySelector("[data-testid=dbg-marker]")).not.toBeNull();

    // Without lanes, the turn preview and both trace panes are gone — the exact
    // "missing turn preview and traces" state of the un-discovered dev page.
    expect(root.querySelector("[data-testid=turn-pane]")).toBeNull();
    expect(root.querySelector("[data-testid=rich-trace-pane]")).toBeNull();
    expect(root.querySelector("[data-testid=trace-pane]")).toBeNull();
  });

  it("omits the target-tab slot and closes the debug pane by default", () => {
    const root = mount({
      lanes: undefined,
      debug: { content: <div data-testid="dbg-marker" /> },
    });

    expect(root.querySelector("[data-testid=tt-marker]")).toBeNull();
    const debug = root.querySelector<HTMLDetailsElement>("[data-testid=extension-debugging]");
    expect(debug?.open).toBe(false); // no debug.open → closed (the extension's default)
    expect(root.querySelector("[data-testid=dbg-marker]")).not.toBeNull();
  });
});
