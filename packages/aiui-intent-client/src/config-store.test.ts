// @vitest-environment jsdom
/**
 * config-store.test.ts — config persistence is AUTO-SAVE (owner, 2026-07-14):
 * every control change writes the store on its own (debounced), and a reload
 * starts from exactly where you left off. No save/reset verbs.
 *
 * Storage is an explicit in-memory stub, never the `localStorage` global:
 * Node ≥22 pre-defines `globalThis.localStorage` (undefined without
 * `--localstorage-file`), and vitest's jsdom environment won't shadow a key
 * the runtime already owns — so the global is a trap here.
 */
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { linter, pencilFade, stt, uiScale } from "./config";
import { installConfigAutoSave, loadConfigBase } from "./config-store";

/** A minimal in-memory `Storage` (the repo's test convention for it). */
function memStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let stop: (() => void) | undefined;
let storage = memStorage();

afterEach(() => {
  stop?.();
  stop = undefined;
  storage = memStorage();
  stt.set(stt.initial as never);
  linter.set(linter.initial as never);
  pencilFade.set(pencilFade.initial as never);
  uiScale.set(uiScale.initial as never);
  flush();
});

describe("config auto-save", () => {
  it("every change persists on its own — a 'reload' starts from it", async () => {
    stop = installConfigAutoSave(storage, 0);
    stt.set("gpt-4o-transcribe" as never);
    pencilFade.set(12 as never);
    flush();
    await tick(); // the debounce beat

    // The "reload": controls fall back to factory, boot re-applies the store.
    stop();
    stop = undefined;
    stt.set(stt.initial as never);
    pencilFade.set(pencilFade.initial as never);
    loadConfigBase(storage);
    flush();
    expect(stt.get()).toBe("gpt-4o-transcribe");
    expect(pencilFade.get()).toBe(12);
  });

  it("debounces a slider drag into one write", async () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_k: string, v: string) => void writes.push(v),
    } as unknown as Storage;
    stop = installConfigAutoSave(storage, 5);
    for (const value of [2, 3, 4, 5, 6]) {
      pencilFade.set(value as never);
      flush();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The drag collapsed to (at most) the trailing write, not five.
    expect(writes.length).toBeLessThanOrEqual(2); // the mount write may precede it
    expect(JSON.parse(writes.at(-1) ?? "{}").pencilFade).toBe(6);
  });

  it("load applies the store at boot", () => {
    storage.setItem("aiui2.config", JSON.stringify({ linter: "gemini", uiScale: 1.4 }));
    loadConfigBase(storage);
    flush();
    expect(linter.get()).toBe("gemini");
    expect(uiScale.get()).toBe(1.4);
  });

  it("a corrupt persisted value never blocks boot", () => {
    storage.setItem("aiui2.config", JSON.stringify({ stt: "no-such-model", pencilFade: 8 }));
    loadConfigBase(storage);
    flush();
    expect(stt.get()).toBe(stt.initial); // invalid: skipped, not thrown
    expect(pencilFade.get()).toBe(8); // valid neighbors still apply
  });
});
