// @vitest-environment jsdom
/**
 * config-store.test.ts — session layering: live values are the session,
 * the saved base lives in localStorage, save/reset/load move between them.
 */
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { inkFade, linter, stt, uiScale } from "./config";
import { loadConfigBase, resetConfigToBase, saveConfigBase } from "./config-store";

afterEach(() => {
  localStorage.removeItem("aiui2.config");
  stt.set(stt.initial as never);
  linter.set(linter.initial as never);
  inkFade.set(inkFade.initial as never);
  uiScale.set(uiScale.initial as never);
});

describe("config session layering", () => {
  it("save → change → reset restores the saved base", () => {
    stt.set("gpt-4o-transcribe" as never);
    inkFade.set(12 as never);
    saveConfigBase();

    stt.set("scribe-v2" as never); // session drift
    inkFade.set(3 as never);
    resetConfigToBase(); // R: discard the session
    flush(); // boundary reads below want the committed values
    expect(stt.get()).toBe("gpt-4o-transcribe");
    expect(inkFade.get()).toBe(12);
  });

  it("reset with NO saved base restores factory defaults", () => {
    stt.set("gpt-4o-mini-transcribe" as never);
    resetConfigToBase();
    flush();
    expect(stt.get()).toBe(stt.initial);
  });

  it("load applies the base at boot (a reload starts from what you saved)", () => {
    linter.set("gemini" as never);
    uiScale.set(1.4 as never);
    saveConfigBase();
    linter.set("off" as never); // the 'reload' reset the controls…
    uiScale.set(1 as never);
    loadConfigBase(); // …boot re-applies the base
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
