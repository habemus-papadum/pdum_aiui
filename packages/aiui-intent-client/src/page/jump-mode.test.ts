// @vitest-environment jsdom
/**
 * jump-mode.test.ts — the in-repo jump-to-editor port: the chains read the
 * attribution contract, the plain-DOM picker walks the overlay's interaction
 * contract (click → picker → digit/Enter → `vscode://` open, Esc → gone).
 */
import { afterEach, describe, expect, it } from "vitest";
import { armJump, cellChain, disarmJump, elementChain, vscodeFileUrl } from "./jump-mode";

const ROOT = "/proj/app";

function page(html: string): void {
  document.body.innerHTML = html;
  (window as unknown as { __AIUI__?: unknown }).__AIUI__ = { v: 1, sourceRoot: ROOT };
}

afterEach(() => {
  disarmJump();
  document.body.innerHTML = "";
  (window as unknown as { __AIUI__?: unknown }).__AIUI__ = undefined;
});

describe("the chains", () => {
  it("element chain walks stamped ancestors nearest → outermost", () => {
    page(
      `<div data-source-loc="src/App.tsx:3"><section data-source-loc="src/Plot.tsx:10">` +
        `<span id="t">hi</span></section></div>`,
    );
    const chain = elementChain(document.getElementById("t") as Element, ROOT);
    expect(chain.map((t) => t.loc)).toEqual(["src/Plot.tsx:10", "src/App.tsx:3"]);
    expect(chain[0].url).toBe("vscode://file/proj/app/src/Plot.tsx:10");
  });

  it("cell chain resolves definition sites; a missing root leaves url absent", () => {
    page(`<div data-cell="plot" data-cell-loc="src/cells.ts:7"><span id="t">hi</span></div>`);
    const target = document.getElementById("t") as Element;
    expect(cellChain(target, ROOT)[0]).toMatchObject({
      kind: "cell",
      label: "plot",
      loc: "src/cells.ts:7",
      url: "vscode://file/proj/app/src/cells.ts:7",
    });
    expect(cellChain(target, undefined)[0].url).toBeUndefined(); // named miss
  });

  it("vscodeFileUrl: absolute stamps need no root; relative + no root = none", () => {
    expect(vscodeFileUrl("/abs/x.ts:1", undefined)).toBe("vscode://file/abs/x.ts:1");
    expect(vscodeFileUrl("rel/x.ts:1", undefined)).toBeUndefined();
  });
});

describe("the pick mode", () => {
  it("click opens the picker; a digit commits the numbered row's vscode link", () => {
    page(`<div data-source-loc="src/App.tsx:3"><span id="t">hi</span></div>`);
    const opened: string[] = [];
    armJump((url) => opened.push(url));

    const target = document.getElementById("t") as Element;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const picker = document.getElementById("__aiui-intent-jump-picker");
    expect(picker?.style.display).toBe("block");
    expect(picker?.textContent).toContain("src/App.tsx:3");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    expect(opened).toEqual(["vscode://file/proj/app/src/App.tsx:3"]);
    // One-shot: the commit tore the mode down.
    expect(document.getElementById("__aiui-intent-jump")).toBeNull();
  });

  it("Esc disarms without opening anything; unstamped click names the miss", () => {
    page(`<span id="t">plain</span>`);
    const opened: string[] = [];
    armJump((url) => opened.push(url));
    (document.getElementById("t") as Element).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(document.getElementById("__aiui-intent-jump-picker")?.textContent).toContain(
      "no source location",
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.getElementById("__aiui-intent-jump")).toBeNull();
    expect(opened).toEqual([]);
  });

  it("onExit fires once on a commit and once on Esc — the panel's auto-exit signal", () => {
    // The completion callback (owner, 2026-07-16) is what flips jump mode off in
    // the panel; it fires on a user-driven end, not on programmatic disarm.
    page(`<div data-source-loc="src/App.tsx:3"><span id="t">hi</span></div>`);
    let exits = 0;
    armJump(
      () => {},
      () => {
        exits += 1;
      },
    );
    (document.getElementById("t") as Element).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })); // commit
    expect(exits).toBe(1);

    // A fresh pick cancelled by Esc also reports exactly one exit.
    armJump(
      () => {},
      () => {
        exits += 1;
      },
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(exits).toBe(2);
  });

  it("the jump click never reaches the page (capture + stopImmediatePropagation)", () => {
    page(`<button id="t" data-source-loc="src/App.tsx:3">danger</button>`);
    let pageSaw = 0;
    document.getElementById("t")?.addEventListener("click", () => {
      pageSaw += 1;
    });
    armJump(() => {});
    (document.getElementById("t") as Element).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(pageSaw).toBe(0); // picking is not clicking
  });
});
