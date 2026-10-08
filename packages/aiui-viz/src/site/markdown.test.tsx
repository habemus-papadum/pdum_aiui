// @vitest-environment jsdom
/**
 * TextView: Markdown by default, the raw text when the toggle is unchecked,
 * and raw HTML in the text escaped rather than injected.
 */
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown, TextView } from "./markdown";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const SAMPLE =
  "## Tools\n\n- `set` — move a control\n- **report** — the whole picture\n\n<b>raw</b>";

describe("TextView", () => {
  it("renders Markdown by default and escapes raw HTML", () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <TextView text={SAMPLE} />, host);
    const md = host.querySelector(".aiui-md");
    expect(md?.querySelector("h2")?.textContent).toBe("Tools");
    expect(md?.querySelectorAll("li").length).toBe(2);
    expect(md?.querySelector("code")?.textContent).toBe("set");
    expect(md?.querySelector("b")).toBeNull(); // escaped, not injected
    expect(md?.textContent).toContain("<b>raw</b>");
  });

  it("shows the raw text when the toggle is unchecked, and back", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <TextView text={SAMPLE} />, host);
    const toggle = host.querySelector<HTMLInputElement>(".aiui-text-toggle input");
    expect(toggle?.checked).toBe(true);
    if (toggle) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".aiui-text-raw")?.textContent).toBe(SAMPLE);
    expect(host.querySelector(".aiui-md")).toBeNull();
  });

  it("can start raw", () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <TextView text={SAMPLE} markdown={false} />, host);
    expect(host.querySelector(".aiui-text-raw")?.textContent).toBe(SAMPLE);
  });

  it("renderMarkdown is the same parser, raw HTML escaped", () => {
    expect(renderMarkdown("a <i>b</i>")).toContain("&lt;i&gt;b&lt;/i&gt;");
    expect(renderMarkdown("a <i>b</i>")).not.toContain("<i>");
  });
});
