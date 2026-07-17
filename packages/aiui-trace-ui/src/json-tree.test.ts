// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderJsonTree } from "./json-tree";

describe("renderJsonTree: collapse/expand structure", () => {
  it("renders an object as a <details> with count, keys, and typed leaves", () => {
    const root = renderJsonTree({ a: 1, b: "two" });
    const details = root.querySelector<HTMLDetailsElement>("details.aiui-dbg-json-node");
    expect(details).not.toBeNull();
    expect(details?.querySelector(".aiui-dbg-json-count")?.textContent).toBe("2 keys");
    const keys = [...root.querySelectorAll(".aiui-dbg-json-key")].map((k) => k.textContent);
    expect(keys).toEqual(["a", "b"]);
  });

  it("auto-opens to the given depth: default 1 (root open, children closed)", () => {
    const root = renderJsonTree({ outer: { inner: 1 } });
    const [outer, inner] = [...root.querySelectorAll<HTMLDetailsElement>("details")];
    expect(outer.open).toBe(true);
    expect(inner.open).toBe(false);

    const deeper = renderJsonTree({ outer: { inner: { core: 1 } } }, { open: 2 });
    const all = [...deeper.querySelectorAll<HTMLDetailsElement>("details")];
    expect(all.map((d) => d.open)).toEqual([true, true, false]);
  });

  it("uses index keys and 'items' for arrays", () => {
    const root = renderJsonTree([10, 20, 30]);
    expect(root.querySelector(".aiui-dbg-json-count")?.textContent).toBe("3 items");
    expect(root.querySelector(".aiui-dbg-json-mark")?.textContent).toBe("[…]");
    const keys = [...root.querySelectorAll(".aiui-dbg-json-key")].map((k) => k.textContent);
    expect(keys).toEqual(["0", "1", "2"]);
  });

  it("renders empty containers as plain {} / [] leaves (nothing to expand)", () => {
    expect(renderJsonTree({}).querySelector("details")).toBeNull();
    expect(renderJsonTree({}).textContent).toBe("{}");
    expect(renderJsonTree([]).textContent).toBe("[]");
    expect(renderJsonTree({ empty: [] }).querySelectorAll("details")).toHaveLength(1);
  });

  it("never hangs on a circular value (not JSON, but must not break)", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const root = renderJsonTree(loop, { open: 3 });
    expect(root.textContent).toContain("[circular]");
  });
});

describe("renderJsonTree: collapsed previews", () => {
  it("shows the first few entries inline, with an ellipsis for the rest", () => {
    const root = renderJsonTree({ a: 1, b: true, c: null, d: 4 });
    const preview = root.querySelector(".aiui-dbg-json-preview")?.textContent ?? "";
    expect(preview).toBe("a: 1, b: true, c: null, …");
  });

  it("previews nested containers as {…} / […] without recursing", () => {
    const root = renderJsonTree({ obj: { x: 1 }, arr: [1, 2] });
    const preview = root.querySelector(".aiui-dbg-json-preview")?.textContent ?? "";
    expect(preview).toBe("obj: {…}, arr: […]");
  });

  it("truncates long strings in the preview but keeps the leaf full", () => {
    const long = "a very long transcript that certainly exceeds the preview budget";
    const root = renderJsonTree({ inner: long });
    const preview = root.querySelector(".aiui-dbg-json-preview")?.textContent ?? "";
    expect(preview).toBe('inner: "a very long transcript t…"');
    // The expanded leaf carries the whole string.
    expect(root.querySelector(".aiui-dbg-json-string")?.textContent).toBe(`"${long}"`);
  });
});

describe("renderJsonTree: typed leaves", () => {
  it("gives each primitive type its class", () => {
    const root = renderJsonTree({ s: "hi", n: 42, b: false, z: null });
    expect(root.querySelector(".aiui-dbg-json-string")?.textContent).toBe('"hi"');
    expect(root.querySelector(".aiui-dbg-json-number")?.textContent).toBe("42");
    expect(root.querySelector(".aiui-dbg-json-boolean")?.textContent).toBe("false");
    expect(root.querySelector(".aiui-dbg-json-null")?.textContent).toBe("null");
  });

  it("wraps absolute paths inside string leaves as interactive path spans", () => {
    const root = renderJsonTree(
      { shot: "saved to /tmp/aiui/shot_1.png for review" },
      { previewUrl: (p) => `http://host/preview?p=${encodeURIComponent(p)}` },
    );
    const path = root.querySelector(".aiui-dbg-json-string .aiui-dbg-path");
    expect(path?.textContent).toBe("/tmp/aiui/shot_1.png");
    expect(path?.classList.contains("img")).toBe(true);
    // The surrounding prose stays plain text inside the quoted leaf.
    expect(root.querySelector(".aiui-dbg-json-string")?.textContent).toBe(
      '"saved to /tmp/aiui/shot_1.png for review"',
    );
  });
});
