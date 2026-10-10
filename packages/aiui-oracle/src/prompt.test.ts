/**
 * The weave — the persona plus the app's named slots.
 *
 * What is worth pinning here is the STRUCTURE, not the wording: the slots
 * render in the weaver's order under the weaver's headings, an absent slot is
 * indistinguishable from an empty one, and `extra` stays the unheaded escape
 * hatch it has always been.
 */
import { type PromptNode, rehydrate } from "@habemus-papadum/aiui-prompts";
import { renderPrompt } from "@habemus-papadum/aiui-viz";
import { describe, expect, it } from "vitest";
import {
  greetingPrompt,
  instructionsPrompt,
  ORACLE_BASE_PERSONA,
  weaveInstructions,
} from "./prompt";

describe("weaveInstructions", () => {
  it("is the bare persona when nothing is supplied", () => {
    expect(weaveInstructions()).toBe(ORACLE_BASE_PERSONA);
    expect(weaveInstructions({})).toBe(ORACLE_BASE_PERSONA);
  });

  it("renders slots in the WEAVER's order, whatever order they were written", () => {
    // The caller's key order must not reach the model: two apps writing the
    // same slots differently would otherwise produce differently-shaped
    // prompts, which is the thing named slots exist to prevent.
    const woven = weaveInstructions({
      extra: "Never mention the weather.",
      stance: "They are new here — offer the tour once.",
      context: "<tab url='/spectra' />",
      app: "A spectrum viewer.",
    });
    const order = ["About this app:", "Right now:", "For this conversation:", "Never mention"].map(
      (needle) => woven.indexOf(needle),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("heads the three named slots and leaves `extra` bare", () => {
    const woven = weaveInstructions({
      app: "A spectrum viewer.",
      context: "<tab url='/spectra' />",
      stance: "Be terse.",
      extra: "Never mention the weather.",
    });
    expect(woven).toContain("About this app: A spectrum viewer.");
    expect(woven).toContain("Right now: <tab url='/spectra' />");
    expect(woven).toContain("For this conversation: Be terse.");
    // The escape hatch: a heading here would just make it a fifth named slot
    // with a worse name.
    expect(woven).toContain("\n\nNever mention the weather.");
  });

  it("renders a tab record as the canonical <tab …/> element, and says so in the record", () => {
    const woven = weaveInstructions({
      app: "A spectrum viewer.",
      context: { url: "http://localhost:5173/spectra", title: "spectra" },
    });
    expect(woven).toContain(
      'Right now: <tab url="http://localhost:5173/spectra" title="spectra"/>',
    );
    const { record } = renderPrompt(
      instructionsPrompt({ context: { url: "http://localhost:5173/spectra" } }),
    );
    const forms = record.definitions.flatMap((definition) =>
      definition.kind === "text" && definition.origin?.form === "tab" ? [definition.origin] : [],
    );
    expect(forms).toEqual([{ site: "aiui-oracle slot", slot: "context", form: "tab" }]);
  });

  it("treats empty and absent identically — a partial record needs no padding", () => {
    // A resolver that has nothing to say about `context` this time returns a
    // record without it, or with "". Neither may leave a dangling heading.
    const partial = weaveInstructions({ app: "A spectrum viewer.", context: "" });
    expect(partial).toBe(weaveInstructions({ app: "A spectrum viewer." }));
    expect(partial).not.toContain("Right now:");
  });

  it("keeps the persona first and unmodified — it is the shared contract", () => {
    expect(weaveInstructions({ app: "x" }).startsWith(ORACLE_BASE_PERSONA)).toBe(true);
  });
});

describe("instructionsPrompt — the weave as nodes", () => {
  it("places each slot under its own key, the heading and the value as separate contributions", () => {
    const rendered = renderPrompt(
      instructionsPrompt({ app: "A spectrum viewer.", extra: "Never mention the weather." }),
    );
    expect(rendered.text).toBe(
      weaveInstructions({ app: "A spectrum viewer.", extra: "Never mention the weather." }),
    );
    const keyed = rendered.compiled.occurrences.filter((o) => o.key !== undefined);
    expect(keyed.map((o) => o.key)).toEqual(["app", "extra"]);
    const sites = rendered.compiled.contributions
      .map((c) => {
        const occurrence = rendered.compiled.occurrences.find((o) => o.id === c.occurrence);
        return occurrence?.origin?.site;
      })
      .filter((site): site is string => typeof site === "string");
    expect(sites).toContain("aiui-oracle persona");
    expect(sites).toContain("aiui-oracle slot heading");
    expect(sites).toContain("aiui-oracle slot");
    // The app's own words are attributed to the slot, not to the weaver.
    const app = rendered.compiled.contributions.find((c) => {
      const occurrence = rendered.compiled.occurrences.find((o) => o.id === c.occurrence);
      return occurrence?.origin?.site === "aiui-oracle slot" && occurrence.origin.slot === "app";
    });
    expect(app).toBeDefined();
    expect(rendered.text.slice(app?.start, app?.end)).toBe("A spectrum viewer.");
  });

  it("is a plain record a ledger can hold and rehydrate", () => {
    const rendered = renderPrompt(instructionsPrompt({ context: "<tab url='/x' />" }));
    const stored = JSON.parse(JSON.stringify(rendered.record));
    expect(rehydrate(stored).parts).toEqual(rendered.compiled.parts);
  });
});

describe("greetingPrompt", () => {
  it("frames a plain string as the priming line, attributing the line to the config", () => {
    const rendered = renderPrompt(greetingPrompt("Hi there.") as PromptNode);
    expect(rendered.text).toBe(
      'Open the conversation by saying exactly: "Hi there.". Say nothing else.',
    );
    const line = rendered.compiled.contributions.find((c) => {
      const occurrence = rendered.compiled.occurrences.find((o) => o.id === c.occurrence);
      return occurrence?.origin?.site === "aiui-oracle config.greeting";
    });
    expect(rendered.text.slice(line?.start, line?.end)).toBe("Hi there.");
  });

  it("hands the object form's brief through unframed, and says nothing for nothing", () => {
    expect(
      renderPrompt(greetingPrompt({ instructions: "Greet them by name." }) as PromptNode).text,
    ).toBe("Greet them by name.");
    expect(greetingPrompt(undefined)).toBeUndefined();
    expect(greetingPrompt("")).toBeUndefined();
    expect(greetingPrompt({ instructions: "" })).toBeUndefined();
  });
});
