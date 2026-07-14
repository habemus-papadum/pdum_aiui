// @vitest-environment jsdom
/**
 * config-store.test.ts — config persistence is AUTO-SAVE (owner, 2026-07-14):
 * every control change writes the store on its own (debounced), and a reload
 * starts from exactly where you left off. No save/reset verbs.
 */
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { inkFade, linter, stt, uiScale } from "./config";
import { installConfigAutoSave, loadConfigBase } from "./config-store";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  localStorage.removeItem("aiui2.config");
  stt.set(stt.initial as never);
  linter.set(linter.initial as never);
  inkFade.set(inkFade.initial as never);
  uiScale.set(uiScale.initial as never);
  flush();
});

describe("config auto-save", () => {
  it("every change persists on its own — a 'reload' starts from it", async () => {
    stop = installConfigAutoSave(localStorage, 0);
    stt.set("gpt-4o-transcribe" as never);
    inkFade.set(12 as never);
    flush();
    await tick(); // the debounce beat

    // The "reload": controls fall back to factory, boot re-applies the store.
    stop();
    stop = undefined;
    stt.set(stt.initial as never);
    inkFade.set(inkFade.initial as never);
    loadConfigBase();
    flush();
    expect(stt.get()).toBe("gpt-4o-transcribe");
    expect(inkFade.get()).toBe(12);
  });

  it("debounces a slider drag into one write", async () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_k: string, v: string) => void writes.push(v),
    } as unknown as Storage;
    stop = installConfigAutoSave(storage, 5);
    for (const value of [2, 3, 4, 5, 6]) {
      inkFade.set(value as never);
      flush();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The drag collapsed to (at most) the trailing write, not five.
    expect(writes.length).toBeLessThanOrEqual(2); // the mount write may precede it
    expect(JSON.parse(writes.at(-1) ?? "{}").inkFade).toBe(6);
  });

  it("load applies the store at boot", () => {
    localStorage.setItem("aiui2.config", JSON.stringify({ linter: "gemini", uiScale: 1.4 }));
    loadConfigBase();
    flush();
    expect(linter.get()).toBe("gemini");
    expect(uiScale.get()).toBe(1.4);
  });

  it("a corrupt persisted value never blocks boot", () => {
    localStorage.setItem("aiui2.config", JSON.stringify({ stt: "no-such-model", inkFade: 8 }));
    loadConfigBase();
    flush();
    expect(stt.get()).toBe(stt.initial); // invalid: skipped, not thrown
    expect(inkFade.get()).toBe(8); // valid neighbors still apply
  });
});
