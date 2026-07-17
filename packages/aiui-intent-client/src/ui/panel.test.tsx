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
import { activationGesture } from "../activation";
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
  clearPencil: () => {},
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
    // No phase pill (owner, 2026-07-14): the ARM CAP carries the state — its
    // lit attribute is the disarmed/armed indicator.
    const armCap = () => m.root.querySelector('[data-command="arm"]');
    expect(armCap()?.getAttribute("data-lit")).toBe("false"); // disarmed

    activationGesture(m.client, 7);
    await settle(); // effects paint on the flush inside dispatch; settle for jsdom
    expect(armCap()?.getAttribute("data-lit")).toBe("true"); // armed-or-deeper
    expect(m.client.state().phase).toBe("turn");

    m.client.dispatch("pencil");
    await settle();
    const pencilCap = m.root.querySelector('[data-command="pencil"]');
    expect(pencilCap?.getAttribute("data-lit")).toBe("true"); // ledger: cap inversions
  });

  it("cap clicks dispatch the same command as the key", async () => {
    const m = mount();
    activationGesture(m.client, 7);
    await settle();
    const sendCap = m.root.querySelector<HTMLButtonElement>('[data-command="send"]');
    expect(sendCap).not.toBeNull();
    sendCap?.click();
    await settle();
    expect(m.client.state().phase).toBe("armed");
    expect(m.root.querySelector('[data-command="arm"]')?.getAttribute("data-lit")).toBe("true");
  });

  it("the help table renders the working keymap and dies on Esc first", async () => {
    const m = mount();
    activationGesture(m.client, 7);
    m.client.handleKey("?", "down", false);
    await settle();
    expect(m.root.querySelector('[data-testid="keymap-help"]')).not.toBeNull();
    expect(text(m.root, "keymap-help")).toContain("pencil");
    // In a turn the table is LIVE: no preview dimming, no how-to-get-there note.
    expect(m.root.querySelector('[data-testid="keymap-help"]')?.hasAttribute("data-preview")).toBe(
      false,
    );
    expect(m.root.querySelector('[data-testid="keymap-help-note"]')).toBeNull();

    m.client.handleKey("Escape", "down", false);
    await settle();
    expect(m.root.querySelector('[data-testid="keymap-help"]')).toBeNull(); // help died…
    expect(m.client.state().phase).toBe("turn"); // …the turn did not
  });

  it("help OUTSIDE a turn previews the full keymap, dimmed, under the activation note", async () => {
    const m = mount();
    m.client.dispatch("help"); // disarmed — no turn anywhere near
    await settle();
    const table = m.root.querySelector('[data-testid="keymap-help"]');
    expect(table).not.toBeNull();
    // The REAL rows, not a lone "activate" shrug — same source as in-turn.
    expect(text(m.root, "keymap-help")).toContain("pencil");
    expect(text(m.root, "keymap-help")).toContain("send");
    // …marked as a preview (dimmed), with the note saying how to get there.
    expect(table?.hasAttribute("data-preview")).toBe(true);
    expect(m.root.querySelector('[data-testid="keymap-help-note"]')).not.toBeNull();
  });

  it("status pills show the operations and the world's facts", async () => {
    const m = mount();
    const pill = (name: string) =>
      m.root.querySelector(`[data-pill="${name}"]`)?.getAttribute("data-state");
    m.client.setContext({ connected: true, micGranted: true, paintClients: 1 });
    activationGesture(m.client, 7);
    await settle();
    expect(pill("stream")).toBe("on"); // warm capture held
    expect(pill("keys")).toBe("on");
    expect(pill("channel")).toBe("on");
    expect(pill("mic")).toBe("on");
    expect(pill("ipad")).toBe("on");
    expect(pill("video")).toBe("off"); // standing setting off — not sampling
    expect(pill("rec")).toBe("off");

    m.client.dispatch("handsFree"); // REC pill goes live with the talk window
    await settle();
    expect(pill("rec")).toBe("live");
    m.client.dispatch("mute");
    await settle();
    expect(pill("rec")).toBe("busy"); // recording but muted
  });

  it("the ring pill goes HOLLOW when the tab in view lacks the grant — like the on-page dot", async () => {
    const m = mount();
    const ring = () => m.root.querySelector('[data-pill="ring"]');
    activationGesture(m.client, 7); // grant minted on tab 7, turn open
    await settle();
    expect(ring()?.getAttribute("data-state")).toBe("live"); // in-turn: breathing red
    expect(ring()?.hasAttribute("data-hollow")).toBe(false); // view IS the granted tab

    // The user looks at another tab: the page there renders a hollow dot
    // (ringForTab), and the pill must say the same thing.
    m.client.setContext({ activeTab: 9 });
    await settle();
    expect(ring()?.getAttribute("data-state")).toBe("live");
    expect(ring()?.hasAttribute("data-hollow")).toBe(true);
    expect(ring()?.getAttribute("title")).toContain("grant");

    // Back on the granted tab: solid again.
    m.client.setContext({ activeTab: 7 });
    await settle();
    expect(ring()?.hasAttribute("data-hollow")).toBe(false);
  });

  it("the push-to-talk cap survives its own press — hold, then release, on ONE node", async () => {
    // Regression (found live): a reference-keyed <For> re-created the button
    // when its own lit flipped, detaching the node mid-press and losing the
    // pointerup. Position-keyed <Repeat> keeps the node; attributes update
    // in place. (Also: the hold cap must stay ENABLED mid-hold — a disabled
    // button swallows the pointerup.)
    const m = mount();
    activationGesture(m.client, 7);
    await settle();
    const ptt = m.root.querySelector<HTMLButtonElement>('[data-command="talkPress"]');
    expect(ptt).not.toBeNull();

    ptt?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(m.client.state().talk).toBe("hold");
    expect(ptt?.isConnected).toBe(true); // the SAME node, still in the DOM
    expect(ptt?.getAttribute("data-lit")).toBe("true"); // updated in place

    ptt?.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await settle();
    expect(m.client.state().talk).toBe("off"); // the release landed
    expect(ptt?.getAttribute("data-lit")).toBe("false");
  });

  it("a swallowed typo blips without touching the machine", async () => {
    const m = mount();
    activationGesture(m.client, 7);
    const before = m.client.state();
    m.client.handleKey("q", "down", false);
    await settle();
    expect(m.client.state()).toBe(before);
    expect(text(m.root, "blip")).toContain("q");
  });
});
