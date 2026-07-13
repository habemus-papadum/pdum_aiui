// @vitest-environment jsdom
/**
 * panel.test.tsx — the panel DOM as a projection: drive the client through
 * dispatch()/handleKey() and assert the rendered truth. This is the test the
 * old panel could never have (extension pages never commit in CDP tabs; the
 * side panel needs a user gesture) — here the panel is a normal page.
 */
import { disposeDurable } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { createIntentClient, type IntentClient, type IntentLanes } from "../client";
import { fakeBus } from "../fake-bus";
import { intentSpec } from "../spec";
import { Panel } from "./panel";

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

const noopLanes: IntentLanes = {
  openTurn: () => {},
  sendTurn: () => {},
  cancelTurn: () => {},
  takeShot: () => {},
  addSelection: () => {},
  clearInk: () => {},
  startTalk: () => {},
  stopTalk: () => {},
  setMicMuted: () => {},
};

interface Mounted {
  client: IntentClient;
  root: HTMLElement;
  blip: (key: string) => void;
  dispose: () => void;
}

let mounted: Mounted | undefined;

function mount(): Mounted {
  const bus = fakeBus({ activeTab: 7 });
  let blipSink: ((key: string) => void) | undefined;
  const client = createIntentClient({
    host: bus,
    lanes: noopLanes,
    onBlip: (key) => blipSink?.(key),
  });
  client.setContext({ grantedTab: 7, connected: true });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = render(
    () => <Panel client={client} registerBlipSink={(sink) => (blipSink = sink)} />,
    root,
  );
  mounted = {
    client,
    root,
    blip: (key) => blipSink?.(key),
    dispose: () => {
      dispose();
      root.remove();
    },
  };
  return mounted;
}

afterEach(async () => {
  mounted?.dispose();
  await mounted?.client.dispose();
  mounted = undefined;
  for (const region of Object.values(intentSpec.regions)) {
    if (region.agent !== undefined) {
      disposeDurable(`control:${region.agent}`);
    }
  }
  for (const region of Object.keys(intentSpec.regions)) {
    disposeDurable(`mode:${region}`);
  }
});

const text = (root: HTMLElement, testid: string): string =>
  root.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";

describe("the panel is a projection", () => {
  it("pill and caps follow a dispatch in the same breath — no repaint to forget", async () => {
    const m = mount();
    await settle();
    expect(text(m.root, "phase-pill")).toBe("disarmed");

    m.client.dispatch("cmdB");
    await settle(); // effects paint on the flush inside dispatch; settle for jsdom
    expect(text(m.root, "phase-pill")).toBe("turn");

    m.client.dispatch("ink");
    await settle();
    const inkCap = m.root.querySelector('[data-command="ink"]');
    expect(inkCap?.getAttribute("data-lit")).toBe("true"); // ledger: cap inversions
  });

  it("cap clicks dispatch the same command as the key", async () => {
    const m = mount();
    m.client.dispatch("cmdB");
    await settle();
    const sendCap = m.root.querySelector<HTMLButtonElement>('[data-command="send"]');
    expect(sendCap).not.toBeNull();
    sendCap?.click();
    await settle();
    expect(m.client.state().phase).toBe("armed");
    expect(text(m.root, "phase-pill")).toBe("armed");
  });

  it("the help table renders the working keymap and dies on Esc first", async () => {
    const m = mount();
    m.client.dispatch("cmdB");
    m.client.handleKey("?", "down", false);
    await settle();
    expect(m.root.querySelector('[data-testid="keymap-help"]')).not.toBeNull();
    expect(text(m.root, "keymap-help")).toContain("ink");

    m.client.handleKey("Escape", "down", false);
    await settle();
    expect(m.root.querySelector('[data-testid="keymap-help"]')).toBeNull(); // help died…
    expect(m.client.state().phase).toBe("turn"); // …the turn did not
  });

  it("claim chips show the operations' status", async () => {
    const m = mount();
    m.client.dispatch("cmdB");
    await settle();
    const ring = m.root.querySelector('[data-claim="ring"]');
    expect(ring?.getAttribute("data-phase")).toBe("active");
    const stream = m.root.querySelector('[data-claim="tabStream"]');
    expect(stream?.getAttribute("data-phase")).toBe("active");
  });

  it("a swallowed typo blips without touching the machine", async () => {
    const m = mount();
    m.client.dispatch("cmdB");
    const before = m.client.state();
    m.client.handleKey("q", "down", false);
    await settle();
    expect(m.client.state()).toBe(before);
    expect(text(m.root, "blip")).toContain("q");
  });
});
