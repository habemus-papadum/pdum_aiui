// @vitest-environment jsdom
import { decodeFrame, jsonCodec } from "@habemus-papadum/aiui-claude-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IntentModality, mountIntentTool, textModality, unmountIntentTool } from "./intent";
import { fakeSocketFactory } from "./test-support/fake-socket";

const HOST_ID = "aiui-intent-tool-host";

afterEach(() => {
  unmountIntentTool();
  // The tool records its port here (setChannelPort), and resolvePort reads it
  // back — drop it so no test inherits the previous one's channel.
  delete window.__AIUI__;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Make `text` the live document selection over its first text node. */
function selectText(el: Element, start = 0, end?: number): void {
  const node = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end ?? node.textContent?.length ?? 0);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("mountIntentTool", () => {
  it("mounts a shadow host with the fab and hidden panel", () => {
    const handle = mountIntentTool({ force: true, port: 4321 });
    const host = document.getElementById(HOST_ID);
    expect(host).not.toBeNull();
    expect(handle.shadowRoot?.querySelector(".fab")?.textContent).toContain("aiui");
    expect((handle.shadowRoot?.querySelector(".panel") as HTMLElement).hidden).toBe(true);
    handle.open();
    expect((handle.shadowRoot?.querySelector(".panel") as HTMLElement).hidden).toBe(false);
  });

  it("is double-injection safe and unmounts cleanly", () => {
    const first = mountIntentTool({ force: true, port: 1 });
    const second = mountIntentTool({ force: true, port: 2 });
    expect(second).toBe(first);
    first.unmount();
    expect(document.getElementById(HOST_ID)).toBeNull();
    expect(window.__aiuiIntentTool).toBeUndefined();
  });

  it("remounts when the app swept the previous host out of the DOM", () => {
    const first = mountIntentTool({ force: true, port: 1 });
    document.body.innerHTML = "<main>the app rebuilt its DOM</main>";
    const second = mountIntentTool({ force: true, port: 2 });
    expect(second).not.toBe(first);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
  });

  it("links the debug icon at the channel port", () => {
    const handle = mountIntentTool({ force: true, port: 4567 });
    const link = handle.shadowRoot?.querySelector("a.iconbtn") as HTMLAnchorElement;
    expect(link.href).toBe("http://127.0.0.1:4567/debug");
  });

  it("logs the mount and its port to the console", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      mountIntentTool({ force: true, port: 4567 });
      expect(info).toHaveBeenCalledWith("aiui: intent tool mounted — channel port 4567");
      unmountIntentTool();
      delete window.__AIUI__; // the first mount recorded its port there
      mountIntentTool({ force: true });
      expect(info).toHaveBeenCalledWith("aiui: intent tool mounted — no channel port");
    } finally {
      info.mockRestore();
    }
  });

  it("resolves the port from the plugin-seeded window.__AIUI__", () => {
    window.__AIUI__ = { v: 1, port: 7777, frames: [] };
    const handle = mountIntentTool({ force: true });
    const link = handle.shadowRoot?.querySelector("a.iconbtn") as HTMLAnchorElement;
    expect(link.href).toBe("http://127.0.0.1:7777/debug");
  });

  it("prefers an explicit port over the seeded one", () => {
    window.__AIUI__ = { v: 1, port: 7777, frames: [] };
    const handle = mountIntentTool({ force: true, port: 8888 });
    const link = handle.shadowRoot?.querySelector("a.iconbtn") as HTMLAnchorElement;
    expect(link.href).toBe("http://127.0.0.1:8888/debug");
  });

  it("hides the tab row for a single modality", () => {
    const handle = mountIntentTool({ force: true, port: 1 });
    const tabs = handle.shadowRoot?.querySelector(".tabs") as HTMLElement;
    expect(tabs.hidden).toBe(true);
    // The [hidden] attribute must actually win over `.tabs { display: flex }`.
    const style = handle.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(style).toContain(".tabs[hidden]");
  });

  it("selects the bundled modality by format name and rejects unknown ones", () => {
    const handle = mountIntentTool({ force: true, port: 1, format: "text-concat" });
    expect(handle.shadowRoot?.querySelector("textarea")).not.toBeNull();
    handle.unmount();
    expect(() => mountIntentTool({ force: true, port: 1, format: "voice" })).toThrow(
      /unknown intent format "voice"/,
    );
  });

  it("mounts custom modalities with tabs", () => {
    const seen: string[] = [];
    const fake = (label: string): IntentModality => ({
      format: "text-concat",
      label,
      mount(container) {
        seen.push(label);
        container.textContent = label;
      },
    });
    const handle = mountIntentTool({ force: true, port: 1, modalities: [fake("A"), fake("B")] });
    expect(seen).toEqual(["A", "B"]);
    const tabs = [...(handle.shadowRoot?.querySelectorAll(".tab") ?? [])];
    expect(tabs.map((t) => t.textContent)).toEqual(["A", "B"]);
  });
});

describe("textModality", () => {
  it("sends the typed text as a single fin frame of a text-concat thread", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({ force: true, port: 4321, webSocketFactory: factory });
    handle.open();

    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "What is the capital of France?";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    await flush();

    expect(sent).toHaveLength(2); // hello + data
    const hello = decodeFrame(sent[0]);
    expect(hello.envelope).toMatchObject({ kind: "hello", format: "text-concat" });
    const data = decodeFrame(sent[1]);
    expect(data.envelope.fin).toBe(true);
    expect(jsonCodec.decode(data.payload)).toEqual({ text: "What is the capital of France?" });

    // Sent state: textarea cleared, status shows success.
    expect(textarea.value).toBe("");
    expect(handle.shadowRoot?.querySelector(".status")?.textContent).toContain("sent ✓");
  });

  it("reports a helpful status when no port is configured", async () => {
    const handle = mountIntentTool({ force: true, modalities: [textModality()] });
    handle.open();
    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    (handle.shadowRoot?.querySelector(".send") as HTMLButtonElement).click();
    await flush();
    expect(handle.shadowRoot?.querySelector(".status")?.textContent).toContain("aiui vite");
  });

  it("ignores empty submissions", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({ force: true, port: 4321, webSocketFactory: factory });
    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "   ";
    (handle.shadowRoot?.querySelector(".send") as HTMLButtonElement).click();
    await flush();
    expect(sent).toHaveLength(0);
  });
});

describe("textModality with an on-screen selection", () => {
  afterEach(() => {
    document.body.querySelector("p")?.remove();
    window.getSelection()?.removeAllRanges();
  });

  it("shows a chip for the selection and rides it on the submit payload", async () => {
    const p = document.createElement("p");
    p.setAttribute("data-source-loc", "src/ui/App.tsx:32:9");
    p.setAttribute("data-cell", "catalog");
    p.textContent = "reaction-diffusion on the GPU";
    document.body.appendChild(p);

    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({ force: true, port: 4321, webSocketFactory: factory });
    handle.open();

    // Select prose in the page; the watcher debounces (~150ms) then shows a chip.
    selectText(p, 0, 18); // "reaction-diffusion"
    await wait(200);

    const chip = handle.shadowRoot?.querySelector(".chip");
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".chip-label")?.textContent).toContain("reaction-diffusion");
    expect(chip?.querySelector(".chip-loc")?.textContent).toBe("src/ui/App.tsx:32:9");

    // Submit: the data frame must carry the selection block (minus `at`).
    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "make this wider";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    await flush();

    expect(sent).toHaveLength(2); // hello + data
    const data = decodeFrame(sent[1]);
    const payload = jsonCodec.decode(data.payload) as {
      text: string;
      selection?: Record<string, unknown>;
    };
    expect(payload.text).toBe("make this wider");
    expect(payload.selection).toMatchObject({
      text: "reaction-diffusion",
      sourceLoc: "src/ui/App.tsx:32:9",
      cell: "catalog",
    });
    expect(payload.selection).not.toHaveProperty("at");

    // A submitted selection is consumed: the chip disappears.
    expect(handle.shadowRoot?.querySelector(".chip")).toBeNull();
  });

  it("sends a bare { text } payload when nothing is selected", async () => {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({ force: true, port: 4321, webSocketFactory: factory });
    handle.open();
    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "no selection here";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    await flush();
    const payload = jsonCodec.decode(decodeFrame(sent[1]).payload);
    expect(payload).toEqual({ text: "no selection here" });
  });
});
