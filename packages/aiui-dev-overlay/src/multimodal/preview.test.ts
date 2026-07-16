// @vitest-environment jsdom
/**
 * Preview behaviors that don't need the whole modality. The preview is the
 * READ-ONLY render of the compiler's accumulator — `composeIntent(events,
 * "replace", { streaming: true })`, nothing else — so these tests drive the
 * engine directly, the same calls mergeLowered makes for server echoes, and
 * assert what renders.
 */

import { composeIntent, Engine } from "@habemus-papadum/aiui-lowering-pipeline";
import { afterEach, describe, expect, it } from "vitest";
import { Preview } from "./preview";

/** The body is Solid-rendered — writes are batched, DOM lands post-flush. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mounted(): { engine: Engine; preview: Preview } {
  const engine = new Engine({});
  engine.setArmed(true);
  const preview = new Preview(engine);
  document.body.append(preview.root);
  return { engine, preview };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the accumulator render (text)", () => {
  it("extensions render clean; a revision flashes the word-diff and settles", async () => {
    const { engine } = mounted();
    const segment = engine.talkStart() ?? 1;
    engine.transcriptDelta(segment, "make the");
    engine.transcriptDelta(segment, "make the curb"); // extension — no flash
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.querySelector(".mm-diff-del")).toBeNull();
    expect(body.textContent).toContain("make the curb");

    engine.transcriptDelta(segment, "make the curve"); // the model revised itself
    await flush();
    expect(body.querySelector(".mm-diff-del")?.textContent?.trim()).toBe("curb");
    expect(body.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("curve");

    await new Promise((resolve) => setTimeout(resolve, 500)); // LIVE_FLASH_MS settle
    expect(body.querySelector(".mm-diff-del")).toBeNull();
    expect(body.textContent).toContain("make the curve");
  });

  it("streams a provisional delta tail, then the final takes over the same row", async () => {
    const { engine } = mounted();
    const segment = engine.talkStart() ?? 1;
    engine.transcriptDelta(segment, "make the");
    engine.transcriptDelta(segment, "make the curve");
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const provisional = body.querySelector(".mm-seg") as HTMLElement;
    expect(provisional.textContent).toBe("make the curve");
    expect(provisional.classList.contains("final")).toBe(false);

    engine.talkEnd();
    engine.transcriptFinal(segment, "make the curve wider", 100, "rt");
    await flush();
    const seg = body.querySelector(".mm-seg") as HTMLElement;
    expect(seg.textContent).toBe("make the curve wider");
    expect(seg.classList.contains("final")).toBe(true);
    expect(body.querySelectorAll(".mm-seg")).toHaveLength(1); // one row, one key
  });

  it("places a screenshot into the LIVE transcript, before any final arrives", async () => {
    // Hands-free: one long segment, deltas streaming, no final yet. Shots used
    // to stack ahead of the whole segment and only jump into place when the
    // final landed. The compiler's `streaming` fold now gives the interleave a
    // provisional run to split, so they land where they were taken.
    let clock = 1000;
    const engine = new Engine({}, () => clock);
    engine.setArmed(true);
    document.body.append(new Preview(engine).root);

    const segment = engine.talkStart() ?? 1; // window opens at 1000
    clock = 1800; // first delta, one 800 ms lag after talk-start
    engine.transcriptDelta(segment, "okay");
    clock = 2090; // the shot event, 70 ms after the gesture at 2020
    engine.shotDone(
      { x: 0, y: 0, w: 10, h: 10 },
      [],
      "data:image/png;base64,x",
      undefined,
      false,
      2020,
    );
    clock = 2800; // the delta carrying the words spoken by 2000
    engine.transcriptDelta(segment, "okay this is a demo.");
    await flush();

    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    // The shot sits after the sentence it followed, not ahead of the segment.
    expect(body.firstElementChild?.textContent?.trim()).toBe("okay this is a demo.");
    expect(body.querySelector(".mm-thumb")).not.toBeNull();

    clock = 3800; // more speech streams in BEHIND the shot
    engine.transcriptDelta(segment, "okay this is a demo. then I can talk again.");
    await flush();
    // Middle row is the shot's island (its text is the hover ✕ affordance).
    const rows = [...body.children].map((el) => el.textContent?.trim());
    expect(rows).toEqual(["okay this is a demo.", "✕", "then I can talk again."]);
    // Both runs are still provisional — the segment has no final.
    expect(body.querySelectorAll(".mm-seg.final")).toHaveLength(0);
    expect(body.querySelectorAll(".mm-seg")).toHaveLength(2);
  });

  it("renders the compiled interleave: text and shots in accumulator order", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "first chunk text", 90, "mock");
    engine.shotDone({ x: 0, y: 0, w: 10, h: 10 }, [], "data:image/png;base64,x", "/tmp/shot_1.png");
    const s2 = engine.talkStart() ?? 2;
    engine.talkEnd();
    engine.transcriptFinal(s2, "second chunk text", 90, "mock");
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const kinds = [...body.querySelectorAll(".mm-seg, .mm-thumb-wrap")].map((el) =>
      el.classList.contains("mm-seg") ? "text" : "shot",
    );
    expect(kinds).toEqual(["text", "shot", "text"]);
  });

  it("a shot's ✕ retracts it from the accumulator (shot-drop streams)", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "look at this", 90, "mock");
    engine.shotDone({ x: 0, y: 0, w: 10, h: 10 }, [], "data:image/png;base64,x", "/tmp/s.png");
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    (body.querySelector(".mm-thumb-x") as HTMLButtonElement).click();
    expect(engine.events.at(-1)).toMatchObject({ type: "shot-drop", marker: "shot_1" });
    await flush();
    expect(body.querySelector(".mm-thumb-wrap")).toBeNull(); // the fold excluded it
  });
});

describe("selection chips in the accumulator", () => {
  it("renders a MINIMAL app-selection chip; a refinement supersedes in place", async () => {
    const { engine } = mounted();
    engine.talkStart(); // opens the thread
    engine.appSelection({ text: "the histogram title", sourceLoc: "src/App.tsx:10:2" });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    let chip = body.querySelector(".mm-sel-chip") as HTMLElement;
    // Minimal: glyph + marker — no inline excerpt, no inline location. The
    // substance rides the title (full text, never JS-truncated) and the peek.
    expect(chip.textContent).toBe("⌖ sel_1");
    expect(chip.classList.contains("mm-sel-app")).toBe(true);

    // A refinement (nothing contentful in between) keeps ONE chip, same marker.
    engine.appSelection({ text: "a different span" });
    await flush();
    expect(body.querySelectorAll(".mm-sel-chip")).toHaveLength(1);
    chip = body.querySelector(".mm-sel-chip") as HTMLElement;
    expect(chip.textContent).toBe("⌖ sel_1");
    // The hover title reads the LATEST fold's payload, not the mount-time one.
    chip.parentElement?.dispatchEvent(new MouseEvent("mouseenter"));
    expect(chip.title).toBe("a different span");
    chip.parentElement?.dispatchEvent(new MouseEvent("mouseleave"));

    engine.appSelectionDrop();
    await flush();
    expect(body.querySelector(".mm-sel-chip")).toBeNull();
  });

  it("chips sit at their accumulator positions, interleaved with the text", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make this wider", 90, "mock");
    engine.appSelection({ text: "the histogram title" });
    const s2 = engine.talkStart() ?? 2;
    engine.talkEnd();
    engine.transcriptFinal(s2, "and match this", 90, "mock");
    engine.appSelection({ text: "the legend caption" });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const seq = [...body.querySelectorAll(".mm-seg, .mm-sel-chip")].map((el) =>
      el.classList.contains("mm-sel-chip") ? el.textContent : "text",
    );
    // text, chip, text, chip — each selection where it happened, own marker.
    expect(seq).toEqual(["text", "⌖ sel_1", "text", "⌖ sel_2"]);
  });

  it("hover peeks the selection (loc + FULL text, CSS-clamped); ✕ drops that marker", async () => {
    const { engine } = mounted();
    const longText =
      "a selected sentence well past any excerpt cap, kept whole in the peek card body";
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make this wider", 90, "mock");
    engine.appSelection({ text: longText, sourceLoc: "src/App.tsx:10:2" });
    engine.transcriptFinal(2, "and this", 90, "mock");
    engine.appSelection({ text: "second selection" });
    await flush();

    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const wraps = [...body.querySelectorAll(".mm-thumb-wrap")] as HTMLElement[];
    expect(wraps).toHaveLength(2);

    // The peek: the mm-thumb-peek pattern as a card — location + the whole
    // text (clamping is CSS line-clamp; nothing is truncated in the DOM).
    wraps[0].dispatchEvent(new MouseEvent("mouseenter"));
    const peek = document.body.querySelector(".mm-sel-peek") as HTMLElement;
    expect(peek).not.toBeNull();
    expect(peek.querySelector(".mm-sel-peek-loc")?.textContent).toBe("src/App.tsx:10:2");
    expect(peek.querySelector(".mm-sel-peek-text")?.textContent).toBe(longText);
    wraps[0].dispatchEvent(new MouseEvent("mouseleave"));
    expect(document.body.querySelector(".mm-sel-peek")).toBeNull();

    // The ✕ drops exactly THIS marker — the other chip survives.
    (wraps[0].querySelector(".mm-thumb-x") as HTMLButtonElement).click();
    expect(engine.events.at(-1)).toMatchObject({ type: "app-selection-drop", marker: "sel_1" });
    await flush();
    const chips = [...body.querySelectorAll(".mm-sel-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["⌖ sel_2"]);
  });

  it("renders a minimal code-selection chip whose ✕ streams a code-selection-drop", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "look at this helper", 90, "mock");
    engine.codeSelection({ text: "function curb()\n{}", sourceLoc: "src/c.ts:1:1", lines: 2 });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const chip = body.querySelector(".mm-sel-chip") as HTMLElement;
    // Same minimal pill language as the app chip; the glyph tells them apart.
    expect(chip.textContent).toBe("⧉ code_1");
    expect(chip.classList.contains("mm-sel-code")).toBe(true);
    // Still a chip, not transcript text: no .mm-seg carries the code.
    const segs = [...body.querySelectorAll(".mm-seg")].map((s) => s.textContent);
    expect(segs.join(" ")).not.toContain("function curb()");

    // The ✕ retracts it — "same thing as deleting a screenshot".
    const wrap = chip.closest(".mm-thumb-wrap") as HTMLElement;
    (wrap.querySelector(".mm-thumb-x") as HTMLButtonElement).click();
    expect(engine.events.at(-1)).toMatchObject({ type: "code-selection-drop", marker: "code_1" });
    await flush();
    expect(body.querySelector(".mm-sel-chip")).toBeNull();
  });

  it("clears the accumulator at thread boundaries", async () => {
    const { engine } = mounted();
    engine.talkStart();
    engine.appSelection({ text: "context" });
    engine.codeSelection({ text: "code", sourceLoc: "a.ts:1:1" });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.querySelectorAll(".mm-sel-chip")).toHaveLength(2); // both chips rendered
    engine.send();
    await flush();
    expect(body.querySelector(".mm-sel-chip")).toBeNull();
  });
});

describe("linter chips (💡 advice in the accumulator)", () => {
  it("renders an ingested linter-note as a chip; the compiler stays unchanged by it", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the plot wider", 90, "mock");
    const before = composeIntent(engine.events).prompt;
    engine.ingestLinter({
      at: 500,
      type: "linter-note",
      text: "ambiguous: which plot?",
      segment: s1,
    });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const chip = body.querySelector(".mm-lint-chip") as HTMLElement;
    expect(chip.textContent).toBe("💡"); // glyph-only, like every other chip
    expect(chip.title).toBe("ambiguous: which plot?");
    expect(composeIntent(engine.events).prompt).toBe(before); // advisory only
  });

  it("the chip's ✕ dismisses LOCALLY — no stream event, the chronicle keeps the note", async () => {
    const { engine } = mounted();
    engine.talkStart();
    engine.ingestLinter({ at: 501, type: "linter-note", text: "clear so far" });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const wrap = body.querySelector(".mm-lint-chip")?.closest(".mm-thumb-wrap") as HTMLElement;
    const eventsBefore = engine.events.length;
    (wrap.querySelector(".mm-thumb-x") as HTMLButtonElement).click();
    await flush();
    expect(body.querySelector(".mm-lint-chip")).toBeNull();
    expect(engine.events.length).toBe(eventsBefore); // no drop event — local only
  });

  it("a lint arriving after the thread closed is dropped (nothing to advise on)", async () => {
    const { engine } = mounted();
    engine.talkStart();
    engine.send(); // thread closes
    engine.ingestLinter({ at: 502, type: "linter-note", text: "too late" });
    expect(engine.events.some((e) => e.type === "linter-note")).toBe(false);
  });
});

describe("the confidence heat map (word logprobs end-to-end in the view)", () => {
  it("renders heat even when DELTAS streamed first (the row must be rebuilt)", async () => {
    // The live-run bug: the delta tail creates the row as plain text; the
    // final (same segment) must not be trapped in that row's shape.
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.transcriptDelta(s1, "make the");
    engine.transcriptDelta(s1, "make the baseline");
    await flush();
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the baseline wider", 90, "gpt-4o-transcribe", [
      { text: "make", logprob: -0.01 },
      { text: "the", logprob: -0.02 },
      { text: "baseline", logprob: -1.1 },
      { text: "wider", logprob: -0.05 },
    ]);
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect([...body.querySelectorAll(".mm-heat-word")].map((w) => w.textContent)).toEqual([
      "make",
      "the",
      "baseline",
      "wider",
    ]);
  });

  it("renders per-word heat spans for a final that carries words", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    // Exactly what wire.mergeLowered feeds the engine for a server final.
    engine.transcriptFinal(s1, "make the baseline wider", 90, "gpt-4o-transcribe", [
      { text: "make", logprob: -0.01 },
      { text: "the", logprob: -0.02 },
      { text: "baseline", logprob: -1.1 }, // the unsure one
      { text: "wider", logprob: -0.05 },
    ]);
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const words = [...body.querySelectorAll(".mm-heat-word")] as HTMLElement[];
    expect(words.map((w) => w.textContent)).toEqual(["make", "the", "baseline", "wider"]);
    // The unsure word carries the strongest tint; a confident one carries none.
    const unsure = words[2];
    expect(unsure.style.background).toContain("rgba(255, 92, 135");
    expect(unsure.title).toContain("-1.10");
    expect(words[0].style.background).toBe("");
  });

  it("retints earlier words when a later segment widens the logprob range", async () => {
    // The range spans the WHOLE turn, so a new segment's worse word rescales
    // every tint already on screen. The words array is reused by reference, so
    // <For> keeps the existing rows — the tint has to be reactive on its own,
    // not computed once in the row's (untracked) child body.
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make foo", 90, "gpt-4o-transcribe", [
      { text: "make", logprob: -0.01 },
      { text: "foo", logprob: -0.3 }, // the worst word SO FAR → full tint
    ]);
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const alphaOf = (el: HTMLElement): number =>
      Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(el.style.background)?.[1] ?? 0);
    const foo = () => [...body.querySelectorAll(".mm-heat-word")][1] as HTMLElement;
    const before = alphaOf(foo());
    expect(before).toBeCloseTo(0.45, 2); // the floor of the range: strongest tint

    // A second segment is far less certain — now "foo" is comparatively safe.
    const s2 = engine.talkStart() ?? 2;
    engine.talkEnd();
    engine.transcriptFinal(s2, "bad ok", 90, "gpt-4o-transcribe", [
      { text: "bad", logprob: -2.0 }, // the new floor
      { text: "ok", logprob: -0.02 },
    ]);
    await flush();
    expect([...body.querySelectorAll(".mm-heat-word")].map((w) => w.textContent)).toEqual([
      "make",
      "foo",
      "bad",
      "ok",
    ]);
    // Same span, same word, rescaled: (−0.3 − −2.0)/(−0.01 − −2.0) ≈ 0.854 unsure-ness
    // inverted onto 0.45 ≈ 0.066. Before the fix this stayed pinned at 0.45.
    expect(alphaOf(foo())).toBeCloseTo(0.066, 2);
    expect(alphaOf(foo())).toBeLessThan(before);
  });
});

describe("linter chip anchoring (the chip belongs to its turn)", () => {
  it("keeps a segment's chip after ITS text, not at the end of the accumulator", async () => {
    const { engine } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "first thing I said", 90, "mock");
    // The lint for seg 1 arrives a beat late — AFTER the user resumed:
    const s2 = engine.talkStart() ?? 2;
    engine.transcriptFinal(s2, "second thing entirely", 90, "mock");
    engine.ingestLinter({ at: 900, type: "linter-note", text: "which thing?", segment: s1 });
    await flush();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const order = [...body.querySelectorAll(".mm-seg, .mm-lint-chip")].map((el) =>
      el.classList.contains("mm-lint-chip")
        ? el.textContent?.slice(0, 5)
        : el.textContent?.slice(0, 5),
    );
    // 💡 sits between the two texts — anchored to seg 1.
    expect(order).toEqual(["first", "💡", "secon"]);
  });
});
