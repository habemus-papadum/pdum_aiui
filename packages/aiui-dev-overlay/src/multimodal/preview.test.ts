// @vitest-environment jsdom
/**
 * Preview behaviors that don't need the whole modality: streaming revision
 * flashes in the transcript, and the correction bar's live zone. The engine
 * is driven directly — the same calls mergeLowered makes for server echoes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { composeIntent, Engine } from "../intent-pipeline";
import { Preview } from "./preview";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mounted(diffFlashMs?: number): { engine: Engine; preview: Preview } {
  const engine = new Engine(diffFlashMs !== undefined ? { diffFlashMs } : {});
  engine.setArmed(true);
  const preview = new Preview(engine);
  document.body.append(preview.root);
  return { engine, preview };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("streaming deltas in the transcript", () => {
  it("extensions render clean; a revision flashes the diff and settles", async () => {
    const { engine } = mounted(30);
    const segment = engine.talkStart() ?? 1;
    engine.transcriptDelta(segment, "make the");
    engine.transcriptDelta(segment, "make the curb"); // extension — no flash
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.querySelector(".mm-diff-del")).toBeNull();
    expect(body.textContent).toContain("make the curb");

    engine.transcriptDelta(segment, "make the curve"); // the model revised itself
    expect(body.querySelector(".mm-diff-del")?.textContent?.trim()).toBe("curb");
    expect(body.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("curve");

    await tick(60); // settle (min(600, diffFlashMs=30))
    expect(body.querySelector(".mm-diff-del")).toBeNull();
    expect(body.textContent).toContain("make the curve");
  });

  it("a final that disagrees with its last delta flashes the same way", () => {
    const { engine } = mounted(30);
    const segment = engine.talkStart() ?? 1;
    engine.transcriptDelta(segment, "tighten the curb");
    engine.talkEnd();
    engine.transcriptFinal(segment, "tighten the curve", 100, "rt");
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.querySelector(".mm-diff-add")?.textContent?.trim()).toBe("curve");
  });
});

describe("chunk-at-a-time editing (the top box)", () => {
  function turnWithShotBetweenChunks() {
    const { engine, preview } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "first chunk text", 90, "mock");
    engine.shotDone({ x: 0, y: 0, w: 10, h: 10 }, [], "data:image/png;base64,x", "/tmp/shot_1.png");
    const s2 = engine.talkStart() ?? 2;
    engine.talkEnd();
    engine.transcriptFinal(s2, "second chunk text", 90, "mock");
    engine.setMode("correct");
    preview.setCorrectMode(true);
    return {
      engine,
      preview,
      editArea: document.querySelector(".mm-edit-area") as HTMLTextAreaElement,
      input: document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement,
    };
  }

  it("opens on the LAST chunk, offers a picker, and a manual edit patches only that chunk", () => {
    const { engine, editArea, input } = turnWithShotBetweenChunks();
    expect(editArea.value).toBe("second chunk text"); // the last chunk, not the document
    expect(document.querySelectorAll(".mm-chunk-chip")).toHaveLength(2);

    editArea.value = "second chunk edited";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // empty box → commit
    expect(engine.mode).toBe("ink");
    const composed = composeIntent(engine.events);
    // The other chunk and the shot are untouched — the edit never left its chunk.
    expect(composed.transcript).toBe("first chunk text second chunk edited");
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot", "text"]);
  });

  it("switching chunks folds pending edits first, then edits the other chunk", () => {
    const { engine, editArea } = turnWithShotBetweenChunks();
    const chip = (i: number) => document.querySelector(`[data-chunk="${i}"]`) as HTMLElement;

    chip(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(editArea.value).toBe("first chunk text");
    editArea.value = "first chunk fixed";
    // Switching away is a boundary: the pending edit folds into the stream.
    chip(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(editArea.value).toBe("second chunk text");
    expect(composeIntent(engine.events).transcript).toBe("first chunk fixed second chunk text");
    // …and it's abortable like any diff (a real correction event was emitted).
    expect(
      engine.events.filter((e) => e.type === "correction" && e.instruction === "(manual edit)"),
    ).toHaveLength(1);
  });
});

describe("the correction bar's live zone", () => {
  it("routes correct-mode deltas to the live zone, folding the final into the textarea", () => {
    const { engine, preview } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the curb thicker", 90, "mock");

    // Enter correct mode: the bar is a fixture of the mode — visible and
    // focused without any selection. Lasso a target the way captureSelection
    // would (the DOM-selection plumbing is covered by the modality tests).
    engine.setMode("correct");
    preview.setCorrectMode(true);
    expect((document.querySelector(".mm-correction-bar") as HTMLElement).style.display).toBe(
      "flex",
    );
    engine.setCorrectionTarget({ from: 9, to: 13, original: "curb" });

    const s2 = engine.talkStart() ?? 2;
    engine.transcriptDelta(s2, "curve");
    const live = document.querySelector(".mm-correction-live") as HTMLElement;
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(live.textContent).toBe("curve");
    expect(body.textContent).not.toContain("curve"); // never rendered as content

    engine.talkEnd();
    engine.transcriptFinal(s2, "curve", 80, "mock");
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    expect(input.value).toBe("curve"); // folded in at the caret
    expect(live.textContent).toBe(""); // the live zone cleared
    expect(engine.correctionTarget).toBeDefined(); // Enter is still the commit
  });

  it("Enter-with-text sends (staying in the mode); empty Enter commits back to ink", () => {
    const { engine, preview } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "use the beat dev server", 90, "mock");

    engine.setMode("correct");
    preview.setCorrectMode(true);
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    input.value = "it's Vite, not beat";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // No lasso → the instruction addresses the whole transcript, carried as an
    // EMPTY span (the corrector prompt's whole-document description mode —
    // sending the full text as "selected" taught the model inverted
    // semantics). The bare engine applies it synchronously (no pipeline hook),
    // so the spinner has already stopped and the box cleared — the bar stays
    // open for more.
    const correction = engine.events.find((e) => e.type === "correction");
    expect(correction).toMatchObject({
      original: "",
      instruction: "it's Vite, not beat",
    });
    expect(engine.mode).toBe("correct"); // sending a fix does NOT leave the mode
    expect(input.value).toBe("");
    expect((document.querySelector(".mm-correction-bar") as HTMLElement).style.display).not.toBe(
      "none",
    );

    // Empty-box Enter: the edit session is done — back to ink, turn NOT sent.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(engine.mode).toBe("ink");
    expect(engine.threadOpen).toBe(true);
  });

  it("Escape aborts the whole edit: every applied diff undone, back to ink", async () => {
    const { engine, preview } = mounted(20);
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the curb thicker", 90, "mock");

    engine.setMode("correct");
    preview.setCorrectMode(true);
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    const body = document.querySelector(".mm-preview-body") as HTMLElement;

    // Two fixes, applied in sequence — spans marked in the top editor.
    editArea.setSelectionRange(9, 13); // "curb"
    input.value = "curve";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    editArea.setSelectionRange(15, 22); // "thicker" (post-fix text)
    input.value = "wider";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(engine.mode).toBe("correct");
    expect(editArea.value).toBe("make the curve wider");

    // ONE Escape: the whole session aborts — both diffs undone (as real
    // correction-undo events), the editor closes, and the mode returns to ink.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(engine.mode).toBe("ink");
    await tick(60); // the undo's diff flash settles (diffFlashMs = 20 here)
    expect(body.textContent).toContain("make the curb thicker");
    expect(engine.events.filter((e) => e.type === "correction")).toHaveLength(2);
    expect(engine.events.filter((e) => e.type === "correction-undo")).toHaveLength(2);
  });

  it("direct edits in the top box become locally-patched corrections on commit", () => {
    const { engine, preview } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the curb thicker", 90, "mock");

    engine.setMode("correct");
    preview.setCorrectMode(true);
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;

    // Type directly into the document, then empty-Enter to commit.
    editArea.value = "make the curve much thicker";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(engine.mode).toBe("ink");
    // The manual edit is a real correction event with a local patch — the
    // composed prompt includes it.
    const manual = engine.events.find(
      (e) => e.type === "correction" && e.instruction === "(manual edit)",
    );
    expect(manual).toBeDefined();
    expect(composeIntent(engine.events).transcript).toBe("make the curve much thicker");
  });

  it("composeIntent honors correction-undo: an aborted fix leaves the prompt", () => {
    const { engine, preview } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "make the curb thicker", 90, "mock");
    engine.setMode("correct");
    preview.setCorrectMode(true);
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    editArea.setSelectionRange(9, 13); // "curb"
    input.value = "curve";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(composeIntent(engine.events).transcript).toBe("make the curve thicker");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(composeIntent(engine.events).transcript).toBe("make the curb thicker");
  });
});

describe("chunk-scoped corrections", () => {
  it("a fix in the active chunk never touches the same word in another chunk", () => {
    const { engine, preview } = mounted();
    // Chunk 1: "the curb is long" · [shot] · Chunk 2 (active): "another curb here"
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "the curb is long", 90, "mock");
    engine.shotDone({ x: 0, y: 0, w: 10, h: 10 }, [], "data:image/png;base64,x", "/tmp/s.png");
    const s2 = engine.talkStart() ?? 2;
    engine.talkEnd();
    engine.transcriptFinal(s2, "another curb here", 90, "mock");

    engine.setMode("correct");
    preview.setCorrectMode(true); // the LAST chunk is active by default
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    expect(editArea.value).toBe("another curb here");
    editArea.setSelectionRange(8, 12); // "curb" in the active chunk
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    input.value = "curve";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // The correction event is scoped to the active chunk's line window —
    // chunk 1 is line 0, the shot splits, chunk 2 is line 1.
    const correction = engine.events.find((e) => e.type === "correction");
    expect(correction).toMatchObject({
      original: "curb",
      scope: { fromLine: 1, toLine: 2 },
    });
    // And the composed transcript proves the reach: chunk 1's "curb" survives.
    const transcript = composeIntent(engine.events).transcript;
    expect(transcript).toContain("the curb is long");
    expect(transcript).toContain("another curve here");
  });
});

describe("selection chips in the transcript", () => {
  it("pins the app-selection chip at the start, updates it, and drops it", () => {
    const { engine } = mounted();
    engine.talkStart(); // opens the thread
    engine.appSelection({ text: "the histogram title", sourceLoc: "src/App.tsx:10:2" });
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    let chip = body.querySelector(".mm-sel-chip") as HTMLElement;
    expect(chip.textContent).toContain('about: "the histogram title"');
    expect(chip.textContent).toContain("src/App.tsx:10:2");
    // Pinned at the START of the transcript flow.
    expect(body.firstElementChild).toBe(chip);

    engine.appSelection({ text: "a different span" });
    chip = body.querySelector(".mm-sel-chip") as HTMLElement;
    expect(chip.textContent).toContain('about: "a different span"');
    expect(body.querySelectorAll(".mm-sel-chip")).toHaveLength(1); // last wins, one chip

    engine.appSelectionDrop();
    expect(body.querySelector(".mm-sel-chip")).toBeNull();
  });

  it("renders a code-selection chip — excerpt AND location — at its stream position", () => {
    const { engine, preview } = mounted();
    const s1 = engine.talkStart() ?? 1;
    engine.talkEnd();
    engine.transcriptFinal(s1, "look at this helper", 90, "mock");
    engine.codeSelection({ text: "function curb()\n{}", sourceLoc: "src/c.ts:1:1", lines: 2 });
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    const chip = body.querySelector(".mm-sel-chip") as HTMLElement;
    // The code rides the chip (whitespace-collapsed) with its location beside
    // it — a bare locator is opaque when debugging — and the full text on hover.
    expect(chip.textContent).toContain("⧉ function curb() {}");
    expect(chip.textContent).toContain("src/c.ts:1:1");
    expect(chip.title).toBe("function curb()\n{}");
    // Still a chip, not transcript text: no .mm-seg carries the code.
    const segs = [...body.querySelectorAll(".mm-seg")].map((s) => s.textContent);
    expect(segs.join(" ")).not.toContain("function curb()");
    // And it does not become an editable chunk (it splits chunks like a shot).
    engine.setMode("correct");
    preview.setCorrectMode(true);
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    expect(editArea.value).toBe("look at this helper");
  });

  it("clears both chip kinds at thread boundaries", () => {
    const { engine } = mounted();
    engine.talkStart();
    engine.appSelection({ text: "context" });
    engine.codeSelection({ text: "code", sourceLoc: "a.ts:1:1" });
    engine.send();
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.querySelector(".mm-sel-chip")).toBeNull();
  });
});
