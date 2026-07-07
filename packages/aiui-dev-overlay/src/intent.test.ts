// @vitest-environment jsdom
import { decodeFrame, jsonCodec } from "@habemus-papadum/aiui-claude-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IntentModality,
  type IntentToolContext,
  type IntentToolHandle,
  mountIntentTool,
  textModality,
  unmountIntentTool,
} from "./intent";
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

  it("hides the debug icon without a debugUrl (the channel serves no HTML to link)", () => {
    const handle = mountIntentTool({ force: true, port: 4567 });
    const link = handle.shadowRoot?.querySelector("a.iconbtn") as HTMLAnchorElement;
    expect(link.style.display).toBe("none");
    expect(link.getAttribute("href")).toBeNull();
  });

  it("prefers the plugin-served debug page, deep-linked to the channel's session", async () => {
    // The 🔍 upgrade path: one /debug/api/info fetch supplies the session
    // label the ?session= pin carries.
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ session: "serve·9·080000" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const handle = mountIntentTool({ force: true, port: 4567, debugUrl: "/__aiui/debug" });
      const link = handle.shadowRoot?.querySelector("a.iconbtn") as HTMLAnchorElement;
      // Immediately: the served page (which itself default-filters).
      expect(link.getAttribute("href")).toBe("/__aiui/debug");
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Upgraded: pinned to this channel's session label.
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4567/debug/api/info");
      expect(link.getAttribute("href")).toBe(
        `/__aiui/debug?session=${encodeURIComponent("serve·9·080000")}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the bare debug page link when the info fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("channel down");
    }) as unknown as typeof fetch;
    try {
      const handle = mountIntentTool({ force: true, port: 4567, debugUrl: "/__aiui/debug" });
      const link = handle.shadowRoot?.querySelector("a.iconbtn") as HTMLAnchorElement;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(link.getAttribute("href")).toBe("/__aiui/debug");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      window.__AIUI__ = { v: 1, port: 7777, frames: [] };
      mountIntentTool({ force: true });
      expect(info).toHaveBeenCalledWith("aiui: intent tool mounted — channel port 7777");
    } finally {
      info.mockRestore();
    }
  });

  it("prefers an explicit port over the seeded one", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      window.__AIUI__ = { v: 1, port: 7777, frames: [] };
      mountIntentTool({ force: true, port: 8888 });
      expect(info).toHaveBeenCalledWith("aiui: intent tool mounted — channel port 8888");
    } finally {
      info.mockRestore();
    }
  });

  it("hides the tab row for a single modality", () => {
    // `text-concat` is the single-modality escape hatch (the default set is two).
    const handle = mountIntentTool({ force: true, port: 1, format: "text-concat" });
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

  it("defaults to the multimodal set: [Multimodal, Text], multimodal active", () => {
    const handle = mountIntentTool({ force: true, port: 1 });
    const tabs = [...(handle.shadowRoot?.querySelectorAll(".tab") ?? [])];
    expect(tabs.map((t) => t.textContent)).toEqual(["Multimodal", "Text"]);
    expect(tabs[0].classList.contains("active")).toBe(true);
    // The tab row is visible (two modalities), and the text tab's textarea exists.
    expect((handle.shadowRoot?.querySelector(".tabs") as HTMLElement).hidden).toBe(false);
    expect(handle.shadowRoot?.querySelector("textarea")).not.toBeNull();
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
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [textModality()],
    });
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
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [textModality()],
    });
    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "   ";
    (handle.shadowRoot?.querySelector(".send") as HTMLButtonElement).click();
    await flush();
    expect(sent).toHaveLength(0);
  });
});

describe("actor self-reporting (trace provenance on the hello)", () => {
  afterEach(() => {
    sessionStorage.removeItem("aiui-actor");
  });

  /** Mount the text modality, submit once, and decode the hello's meta. */
  async function helloMetaFor(actor?: string): Promise<Record<string, unknown> | undefined> {
    const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [textModality()],
      ...(actor === undefined ? {} : { actor }),
    });
    handle.open();
    const textarea = handle.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "who is driving?";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    await flush();
    const hello = decodeFrame(sent[0]);
    return (hello.envelope as { meta?: Record<string, unknown> }).meta;
  }

  it("defaults to 'human' in a plain page", async () => {
    expect((await helloMetaFor())?.actor).toBe("human");
  });

  it("honors the per-tab opt-in toggle (sessionStorage 'aiui-actor')", async () => {
    // The explicit opt-in an agent/CI run flips in the tab it drives — never a
    // webdriver heuristic (browser-wide in the shared session browser, where
    // it mislabeled the human's own turns; see ACTOR_STORAGE_KEY).
    sessionStorage.setItem("aiui-actor", "agent");
    expect((await helloMetaFor())?.actor).toBe("agent");
  });

  it("threads an explicit actor option through every thread's hello", async () => {
    // The option outranks the tab toggle.
    sessionStorage.setItem("aiui-actor", "agent");
    expect((await helloMetaFor("bot-7"))?.actor).toBe("bot-7");
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
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [textModality()],
    });
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
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [textModality()],
    });
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

describe("error toasts (the generic error surface)", () => {
  /** A modality that hands its context out so tests can drive reportError/openThread. */
  function capturingModality(): { modality: IntentModality; ctx: () => IntentToolContext } {
    let captured: IntentToolContext | undefined;
    return {
      modality: {
        format: "intent-v1",
        label: "Capture",
        mount(_container, ctx) {
          captured = ctx;
          return undefined;
        },
      },
      ctx: () => {
        if (!captured) {
          throw new Error("modality never mounted");
        }
        return captured;
      },
    };
  }

  const toastsIn = (handle: IntentToolHandle) => [
    ...(handle.shadowRoot?.querySelectorAll(".toast") ?? []),
  ];

  it("renders a dismissible toast from reportError, outside the panel", () => {
    const { modality, ctx } = capturingModality();
    const handle = mountIntentTool({ force: true, port: 4321, modalities: [modality] });

    ctx().reportError({
      source: "transcription",
      message: "transcription failed (401)",
      detail: "check OPENAI_API_KEY",
    });

    // Visible without opening the panel — the whole point of the toast surface.
    expect((handle.shadowRoot?.querySelector(".panel") as HTMLElement).hidden).toBe(true);
    const [toast] = toastsIn(handle);
    expect(toast).toBeDefined();
    expect(toast.querySelector(".toast-source")?.textContent).toBe("transcription");
    expect(toast.querySelector(".toast-msg")?.textContent).toBe("transcription failed (401)");
    expect(toast.querySelector(".toast-detail")?.textContent).toBe("check OPENAI_API_KEY");

    (toast.querySelector(".toast-dismiss") as HTMLButtonElement).click();
    expect(toastsIn(handle)).toHaveLength(0);
  });

  it("dedupes repeats into one toast with a ×N badge and caps the column", () => {
    const { modality, ctx } = capturingModality();
    const handle = mountIntentTool({ force: true, port: 4321, modalities: [modality] });

    // The repeat storm (a dead thread rejecting every audio frame)…
    ctx().reportError({ source: "channel", message: "audio frame rejected: connection closed" });
    ctx().reportError({ source: "channel", message: "audio frame rejected: connection closed" });
    ctx().reportError({ source: "channel", message: "audio frame rejected: connection closed" });
    expect(toastsIn(handle)).toHaveLength(1);
    expect(toastsIn(handle)[0].querySelector(".toast-count")?.textContent).toBe("×3");

    // …and a burst of distinct errors never exceeds the cap.
    for (let i = 0; i < 5; i++) {
      ctx().reportError({ message: `distinct error ${i}` });
    }
    expect(toastsIn(handle).length).toBeLessThanOrEqual(3);
  });

  it("routes a server-pushed kind:'error' message into the toasts", async () => {
    const { factory, push } = fakeSocketFactory(() => ({ ok: true }));
    const { modality, ctx } = capturingModality();
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [modality],
    });

    await ctx().openThread();
    push({
      kind: "error",
      threadId: "some-thread",
      source: "correction",
      message: "correction failed — applied as a plain replacement instead: 401",
    });

    const [toast] = toastsIn(handle);
    expect(toast).toBeDefined();
    expect(toast.querySelector(".toast-source")?.textContent).toBe("correction");
    expect(toast.querySelector(".toast-msg")?.textContent).toContain("plain replacement");
  });

  it("toasts an unexpected mid-thread socket drop through the same surface", async () => {
    const { factory, drop } = fakeSocketFactory(() => ({ ok: true }));
    const { modality, ctx } = capturingModality();
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [modality],
    });

    await ctx().openThread();
    drop(1012, "channel reload"); // the channel restarting out from under the turn

    const [toast] = toastsIn(handle);
    expect(toast).toBeDefined();
    expect(toast.querySelector(".toast-source")?.textContent).toBe("connection");
    expect(toast.querySelector(".toast-msg")?.textContent).toContain("channel reload");
  });

  it("toasts a refused connection (hello rejected) and still rejects openThread", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: false, error: "unknown format" }));
    const { modality, ctx } = capturingModality();
    const handle = mountIntentTool({
      force: true,
      port: 4321,
      webSocketFactory: factory,
      modalities: [modality],
    });

    await expect(ctx().openThread()).rejects.toThrow("unknown format");
    const [toast] = toastsIn(handle);
    expect(toast).toBeDefined();
    expect(toast.querySelector(".toast-source")?.textContent).toBe("connection");
    expect(toast.querySelector(".toast-msg")?.textContent).toContain("unknown format");
  });

  it("toasts when no channel port is configured at all", async () => {
    const { modality, ctx } = capturingModality();
    const handle = mountIntentTool({ force: true, modalities: [modality] });

    await expect(ctx().openThread()).rejects.toThrow(/no channel port/);
    const [toast] = toastsIn(handle);
    expect(toast?.querySelector(".toast-msg")?.textContent).toContain("no channel port");
  });
});
