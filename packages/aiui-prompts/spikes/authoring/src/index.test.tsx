import { describe, expect, it } from "vitest";
import { greeting } from "./examples/01-greeting.prompt.tsx";
import { evidence, investigation } from "./examples/02-reuse-and-selection.prompt.tsx";
import { equation, sciencePrompt } from "./examples/03-scientific.prompt.tsx";
import { tablePrompt } from "./examples/04-tables.prompt.tsx";
import { example as historyExample } from "./examples/06-history.prompt.tsx";
import { example as multiMessageExample } from "./examples/07-current-messages.prompt.tsx";
import type { CompiledPrompt } from "./index.ts";
import {
  Choice,
  compilePrompt,
  explainRange,
  Group,
  Image,
  Join,
  Paragraph,
  Prompt,
  prepareRequest,
  renderTurn,
  Section,
  Text,
  Xml,
} from "./index.ts";

const text = (prompt: CompiledPrompt) =>
  prompt.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

describe("owned TSX authoring experiment", () => {
  it("executes ordinary JSX interpolation and conditionals", () => {
    expect(text(compilePrompt(greeting("Ada", true)))).toBe(
      "Hello, Ada!\n\nKeep your answer concise.",
    );
    expect(text(compilePrompt(greeting("Ada", false)))).toBe("Hello, Ada!");
  });

  it("gives immutable reused definitions distinct occurrence depths", () => {
    const before = JSON.stringify(evidence);
    const compiled = compilePrompt(investigation);
    const definition = compiled.definitions.find(
      (item) => item.source?.label === "reusable evidence",
    );
    const occurrences = compiled.occurrences.filter((item) => item.definition === definition?.id);
    expect(occurrences.map((item) => item.headingLevel)).toEqual([1, 2]);
    expect(new Set(occurrences.map((item) => item.id)).size).toBe(2);
    expect(text(compiled)).toContain("# Evidence\n\nThe observed value is 4.500 eV.");
    expect(text(compiled)).toContain("## Evidence\n\nThe observed value is 4.500 eV.");
    expect(JSON.stringify(evidence)).toBe(before);
    expect(Object.isFrozen(evidence.children)).toBe(true);
    expect(compilePrompt(investigation)).toEqual(compiled);
  });

  it("preserves exact TeX, precision, Unicode units, and text-image-text ordering", async () => {
    const compiled = compilePrompt(await sciencePrompt());
    expect(compiled.parts.map((part) => part.type)).toEqual(["text", "image", "text"]);
    expect(text(compiled)).toContain(`$$\n${equation}\n$$`);
    expect(text(compiled)).toContain("4.500 eV");
    expect(text(compiled)).toContain("1.900 Å⁻¹");
    expect(text(compiled)).not.toContain("fixture:morse-curve");
    expect(compiled.metrics.images).toBe(1);
    expect(compiled.metrics.tokenCount).toBeNull();
  });

  it("escapes XML text, attributes and join separators without escaping child tags", () => {
    const compiled = compilePrompt(
      <Xml tag="data" attributes={{ note: 'A & "B"\nC' }}>
        <Xml tag="value">{"x < y & z"}</Xml>
        <Join separator=" & ">{["one", "two"]}</Join>
      </Xml>,
    );
    expect(text(compiled)).toBe(
      '<data note="A &amp; &quot;B&quot;&#10;C"><value>x &lt; y &amp; z</value>one &amp; two</data>',
    );
    expect(() => Xml({ tag: "broken tag" })).toThrow("Invalid XML tag");
    expect(() => compilePrompt(<Xml tag="data">{"\u0000"}</Xml>)).toThrow("XML 1.0");
    expect(() =>
      compilePrompt(
        <Xml tag="data">
          <Image asset={{ id: "x", uri: "fixture:x", mimeType: "image/png", alt: "x" }} />
        </Xml>,
      ),
    ).toThrow("not supported inside XML");
  });

  it("maps a table cell through text coalescing with exact UTF-16 output offsets", () => {
    const compiled = compilePrompt(tablePrompt());
    const output = text(compiled);
    const start = output.indexOf("42");
    const explanation = explainRange(compiled, 0, start, start + 2);
    expect(explanation).toHaveLength(1);
    expect(explanation[0]?.source?.label).toBe("dynamic cell");
    expect(output).toContain("| Region A | 45 | 18 |\n| Region B | 38 | 22 |");
    const unicode = compilePrompt(
      <Paragraph>
        🔬<Text value="Å" source={{ label: "unit" }} />
      </Paragraph>,
    );
    expect(explainRange(unicode, 0, 2, 3)[0]?.source?.label).toBe("unit");
  });

  it("maps every output code unit exactly once, including generated boundaries", async () => {
    const compiled = compilePrompt(await sciencePrompt());
    for (const [index, part] of compiled.parts.entries()) {
      const mappings = compiled.outputMap.filter((map) => map.part === index);
      if (part.type === "image") {
        expect(mappings).toHaveLength(1);
        expect(mappings[0]?.relation).toBe("asset");
      } else {
        let cursor = 0;
        for (const map of mappings) {
          expect(map.start).toBe(cursor);
          cursor = map.end ?? -1;
        }
        expect(cursor).toBe(part.text.length);
      }
    }
  });

  it("selects full/short/omit without leaving empty sections or separators", () => {
    const prompt = (
      <Prompt>
        <Paragraph>Required.</Paragraph>
        <Section title="Optional">
          <Choice name="detail" short="Short.">
            Full.
          </Choice>
        </Section>
      </Prompt>
    );
    expect(text(compilePrompt(prompt, { selection: { detail: "omit" } }))).toBe("Required.");
    expect(text(compilePrompt(prompt, { selection: { detail: "short" } }))).toBe(
      "Required.\n\n# Optional\n\nShort.",
    );
    expect(text(compilePrompt(prompt))).toContain("Full.");
    expect(() => compilePrompt(prompt, { selection: { typo: "omit" } })).toThrow(
      "Unknown choice name",
    );
    const omitted = compilePrompt(prompt, { selection: { detail: "omit" } });
    expect(omitted.definitions.some((item) => item.value === "Full.")).toBe(true);
    expect(omitted.occurrences.some((item) => item.selected === "omit")).toBe(true);
  });

  it("keeps explicit and remote history separate from current selection", () => {
    const result = historyExample();
    expect(result.full.history).toEqual(result.selected.history);
    expect(result.full.current).not.toEqual(result.selected.current);
    expect(result.remote.current.messages).toHaveLength(1);
    expect(result.remote.history.kind).toBe("remote");
    expect(result.remote.accounting.history).toBe("unknown-server-state");
    expect(result.remote.accounting.requestTokens).toBeNull();
    expect(result.providerReplay.history).toEqual({
      kind: "provider-items",
      protocol: "example-provider/replay-v1",
      items: [
        { type: "function_call", call_id: "call-1", name: "measure", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "4.500 eV" },
      ],
    });
  });

  it("snapshots history without freezing or retaining caller-owned mutable arrays", () => {
    const replay = [{ call_id: "call-1", output: "4.500 eV" }];
    const prepared = prepareRequest(
      renderTurn({ input: compilePrompt(<Paragraph>Next.</Paragraph>) }),
      {
        history: { kind: "provider-items", protocol: "fixture", items: replay },
      },
    );
    replay[0].output = "changed";
    replay.push({ call_id: "call-2", output: "new" });
    expect(prepared.history).toEqual({
      kind: "provider-items",
      protocol: "fixture",
      items: [{ call_id: "call-1", output: "4.500 eV" }],
    });
    expect(Object.isFrozen(prepared.history)).toBe(true);
  });

  it("renders multiple current messages while instructions stay a separate contribution", () => {
    const { prepared } = multiMessageExample();
    expect(prepared.current.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(prepared.current.instructions).toEqual([
      { type: "text", text: "Preserve units and lexical precision." },
    ]);
    expect(prepared.history).toEqual({ kind: "none" });
    expect(prepared.status).toBe("prepared-not-sent");
  });

  it("preserves exact string leaf whitespace and rejects unsupported implicit children", () => {
    const exact = "\n  first\r\n    second\n";
    expect(text(compilePrompt(<Text value={exact} />))).toBe(exact);
    expect(() => Group({ children: undefined })).toThrow("Undefined prompt child");
    // @ts-expect-error Promises must resolve before composition, even though TSX accepts expressions.
    expect(() => Group({ children: Promise.resolve("unprepared") })).toThrow("prepared values");
  });
});
