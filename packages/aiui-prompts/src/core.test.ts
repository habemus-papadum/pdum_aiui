import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mixedDelegation } from "../test/fixtures/mixed-delegation.ts";
import { compilePrompt, rehydrate } from "./compile.ts";
import { canonicalJson, sha256 } from "./json.ts";
import { createElement, jsx } from "./jsx-runtime.ts";
import {
  CapabilityList,
  Case,
  Choice,
  type CompiledPrompt,
  Elide,
  Group,
  Image,
  Join,
  Marker,
  Paragraph,
  Prompt,
  Math as PromptMath,
  type PromptValue,
  Section,
  Text,
  ToolBrief,
  ToolJson,
  Use,
  Xml,
} from "./model.ts";
import {
  parseRecord,
  semanticFingerprint,
  serializeRecord,
  snapshot,
  validateRecord,
  withRecordOptions,
} from "./record.ts";

import { toolSnapshot } from "./tools-data.ts";

const rendered = (compiled: CompiledPrompt) =>
  compiled.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
function covers(compiled: CompiledPrompt) {
  for (const part of compiled.parts) {
    const contributions = compiled.contributions.filter((entry) => entry.part === part.id);
    if (part.type === "image") {
      expect(contributions).toHaveLength(1);
      expect(contributions[0].start).toBeUndefined();
      continue;
    }
    let position = 0;
    for (const contribution of contributions) {
      expect(contribution.start).toBe(position);
      expect(contribution.end).toBeGreaterThan(position);
      position = contribution.end as number;
    }
    expect(position).toBe(part.text.length);
  }
}
function resign(record: unknown): unknown {
  const { fingerprint: _fingerprint, ...body } = JSON.parse(JSON.stringify(record));
  return { ...body, fingerprint: semanticFingerprint(body) };
}

describe("portable canonical semantic record", () => {
  it("matches standard SHA-256 vectors, Unicode and multiblock inputs", () => {
    for (const text of ["", "abc", "😀 e\u0301 科学", "a".repeat(10000)])
      expect(sha256(text)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
  });
  it("round-trips only the semantic graph and reproduces exact artifacts", () => {
    const record = snapshot(
      Prompt({
        children: [
          Section({ title: "Energy", children: "4.500 eV" }),
          PromptMath({ value: String.raw`\hat{H}\psi=E\psi` }),
        ],
      }),
    );
    const json = serializeRecord(record);
    expect(json).not.toContain("contributions");
    expect(json).not.toContain("parts");
    expect(json).not.toContain("# Energy");
    expect(rehydrate(parseRecord(json))).toEqual(compilePrompt(record));
    expect(serializeRecord(parseRecord(json))).toBe(json);
    expect(validateRecord(record)).toEqual([]);
    expect(record.schemaVersion).toBe(1);
  });
  it("copies and freezes retained data without freezing application inputs", () => {
    const asset = { id: "plot", metadata: { run: 42 } };
    const origin = { event: { id: "event-1" } };
    const context = { session: { reason: "start" } };
    const selection = {};
    const value = Image({ asset, origin });
    const record = snapshot(value, { context, selection });
    asset.metadata.run = 99;
    origin.event.id = "changed";
    context.session.reason = "refresh";
    expect(Object.isFrozen(asset)).toBe(false);
    expect(Object.isFrozen(context.session)).toBe(false);
    expect(
      record.definitions[0].kind === "image" && record.definitions[0].asset.metadata?.run,
    ).toBe(42);
    expect(record.context).toEqual({ session: { reason: "start" } });
    expect(Object.isFrozen(record.context.session)).toBe(true);
  });
  it("rejects schema and compiler changes instead of silently selecting the current compiler", () => {
    const record = snapshot("hello");
    expect(() => parseRecord({ ...record, schemaVersion: 2 })).toThrow(/schema version 2/);
    expect(() =>
      rehydrate({ ...record, compiler: { ...record.compiler, version: "99.0.0" } } as never),
    ).toThrow(/not installed/);
    expect(validateRecord({ ...record, kind: "something-else" })[0].code).toBe("INVALID_RECORD");
  });
  it("detects tampering independently of JSON field ordering", () => {
    const record = snapshot("hello");
    const changed = { ...record, context: { reason: "refresh" } };
    expect(() => parseRecord(changed)).toThrow(/fingerprint/);
    expect(parseRecord(JSON.stringify(record, null, 2))).toEqual(record);
  });
  it("rejects getters without calling them, cycles, promises, sparse arrays and nonfinite JSON", () => {
    let getterCalls = 0;
    const malicious = {
      get session() {
        getterCalls++;
        return "start";
      },
    };
    expect(() => snapshot("hello", { context: malicious })).toThrow(/Accessor/);
    expect(getterCalls).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => snapshot("hello", { context: cyclic as never })).toThrow(/Cyclic/);
    expect(() => snapshot(Promise.resolve("hello") as never)).toThrow(/plain JSON/);
    expect(() => snapshot("hello", { context: { cost: Infinity } })).toThrow(/Non-JSON/);
    // biome-ignore lint/suspicious/noSparseArray: Verify holes cannot silently become null during persistence.
    expect(() => snapshot(["a", , "b"] as never)).toThrow(/Non-JSON/);
  });
  it("validates every branch and every graph edge, including unselected definitions", () => {
    const record = snapshot(Choice({ name: "variant", children: "full", short: "short" }));
    const broken = JSON.parse(serializeRecord(record));
    broken.definitions.find((def: { kind: string }) => def.kind === "choice").short.definition =
      "missing";
    expect(() => parseRecord(resign(broken))).toThrow(/Dangling/);
    const cycle = JSON.parse(serializeRecord(snapshot(Group({ children: "a" }))));
    cycle.definitions[0].children[0].definition = "d0";
    expect(() => parseRecord(resign(cycle))).toThrow(/Cyclic/);
    const extra = { ...record, unknown: "do not discard" };
    expect(() => parseRecord(resign(extra))).toThrow(/Unknown record field/);
  });
});

describe("context decisions are part of the durable record", () => {
  const conditional = () =>
    Case({
      name: "session-greeting",
      branches: [
        {
          label: "first start",
          when: {
            op: "all",
            predicates: [
              { op: "eq", path: "session.reason", value: "start" },
              { op: "eq", path: "session.turns", value: 0 },
            ],
          },
          value: "Welcome.",
        },
        {
          label: "reconnect",
          when: { op: "eq", path: "session.reason", value: "reconnect" },
          value: "We reconnected.",
        },
      ],
      fallback: "Continue.",
    });
  it("records selected branch and observed facts while preserving alternatives", () => {
    const record = snapshot(conditional(), { context: { session: { reason: "start", turns: 0 } } });
    expect(record.decisions[0]).toMatchObject({
      kind: "case",
      name: "session-greeting",
      selected: "0",
      facts: [
        { path: "session.reason", present: true, value: "start" },
        { path: "session.turns", present: true, value: 0 },
      ],
    });
    expect(serializeRecord(record)).toContain("We reconnected.");
    expect(rendered(rehydrate(record))).toBe("Welcome.");
    const next = withRecordOptions(record, {
      context: { session: { reason: "refresh", turns: 3 } },
    });
    expect(rendered(rehydrate(next))).toBe("Continue.");
    expect(next.fingerprint).not.toBe(record.fingerprint);
    expect(record.context).toEqual({ session: { reason: "start", turns: 0 } });
  });
  it("distinguishes missing from null and records unsuccessful predicates", () => {
    const record = snapshot(
      Case({
        name: "missing",
        branches: [{ when: { op: "eq", path: "missing", value: null }, value: "null" }],
        fallback: "absent",
      }),
    );
    expect(record.decisions[0].facts).toEqual([{ path: "missing", present: false, value: null }]);
    expect(rendered(rehydrate(record))).toBe("absent");
  });
  it("detects a re-signed but false recorded decision", () => {
    const record = snapshot(conditional(), { context: { session: { reason: "start", turns: 0 } } });
    expect(() =>
      parseRecord(
        resign({ ...record, decisions: [{ ...record.decisions[0], selected: "fallback" }] }),
      ),
    ).toThrow(/decisions/);
  });
  it("scopes duplicate choice names to independent keyed placements", () => {
    const value = Choice({ name: "background", children: "long background", short: "short" });
    const record = snapshot(
      Join({
        separator: " | ",
        children: [Use({ key: "left", value }), Use({ key: "right", value })],
      }),
    );
    const [first, second] = record.decisions;
    const selected = withRecordOptions(record, {
      selection: {
        [`${first.occurrence}:background`]: "omit",
        [`${second.occurrence}:background`]: "short",
      },
    });
    expect(rendered(rehydrate(selected))).toBe("short");
    expect(selected.decisions.map((decision) => decision.selected)).toEqual(["omit", "short"]);
  });
});

describe("compilation and contribution maps", () => {
  it("resolves reused sections globally with one semantic definition and independent occurrences", () => {
    const evidence = Section({ title: "Evidence", children: "4.500 eV" });
    const record = snapshot(
      Prompt({
        children: [
          Use({ key: "primary", value: evidence }),
          Section({ title: "Check", children: Use({ key: "repeat", value: evidence }) }),
        ],
      }),
    );
    const compiled = rehydrate(record);
    expect(
      record.definitions.filter((def) => def.kind === "section" && def.title === "Evidence"),
    ).toHaveLength(1);
    expect(rendered(compiled)).toBe("# Evidence\n\n4.500 eV\n\n# Check\n\n## Evidence\n\n4.500 eV");
    const definitions = compiled.occurrences.filter(
      (occurrence) => occurrence.kind === "section" && occurrence.id !== "o/1",
    );
    expect(new Set(definitions.map((occurrence) => occurrence.id)).size).toBe(definitions.length);
    covers(compiled);
  });
  it("preserves JSX keys as placements, rejects duplicate siblings, and never invokes components on replay", () => {
    let calls = 0;
    const component = () => {
      calls++;
      return Text({ value: "hello" });
    };
    const value = Group({ children: [jsx(component, {}, "first"), jsx(component, {}, "second")] });
    const record = snapshot(value);
    rehydrate(record);
    rehydrate(record);
    expect(calls).toBe(2);
    expect(
      rehydrate(record)
        .occurrences.filter((occurrence) => occurrence.key)
        .map((occurrence) => occurrence.key),
    ).toEqual(["first", "second"]);
    expect(() =>
      snapshot(
        Group({ children: [Use({ key: "same", value: "a" }), Use({ key: "same", value: "b" })] }),
      ),
    ).toThrow(/unique/);
    expect(() => jsx((() => Promise.resolve("x")) as never, {})).toThrow(/prepared/);
  });
  it("rejects undefined and bare numbers instead of silently changing scientific content", () => {
    expect(() => Paragraph({ children: undefined as never })).toThrow(/undefined/);
    expect(() => Paragraph({ children: 4.5 as never })).toThrow(/numbers/);
    expect(rendered(compilePrompt(Text({ value: "4.500 eV\r\n  retained" })))).toBe(
      "4.500 eV\r\n  retained",
    );
  });
  it("keeps a split equation intact and exposes exact owners and enclosing semantic scope", () => {
    const compiled = compilePrompt(
      Paragraph({
        children: [
          "Energy ",
          PromptMath({
            mode: "inline",
            children: [
              Text({ value: String.raw`\frac{`, origin: { event: "a" } }),
              Text({ value: "a}{b}", origin: { event: "b" } }),
            ],
          }),
          ".",
        ],
      }),
    );
    expect(rendered(compiled)).toBe(String.raw`Energy $\frac{a}{b}$.`);
    covers(compiled);
    const region = compiled.semanticRegions[0];
    const part = compiled.parts[0];
    expect(region).toMatchObject({ kind: "math", mode: "inline" });
    expect(part.type === "text" && part.text.slice(region.start, region.end)).toBe(
      String.raw`$\frac{a}{b}$`,
    );
    expect(compiled.contributions.filter((entry) => entry.relation === "authored")).toHaveLength(4);
  });
  it("keeps ordered image placements and counts each output code unit once", () => {
    const compiled = compilePrompt(
      Group({
        children: [
          "before 😀",
          Image({ asset: { id: "plot", uri: "asset:plot", revision: "r1", digest: "sha256:123" } }),
          "after",
        ],
      }),
    );
    expect(compiled.parts.map((part) => part.type)).toEqual(["text", "image", "text"]);
    covers(compiled);
    expect(compiled.contributions[0].end).toBe(9);
  });
  it("maps globally generated separators, headings, XML escaping, and marker syntax", () => {
    const compiled = compilePrompt(
      Prompt({
        children: [
          Section({
            title: "Evidence",
            children: Xml({
              tag: "value",
              attributes: { unit: '"eV"' },
              children: ["a<&", Xml({ tag: "b", children: "x>y" })],
            }),
          }),
          Marker({
            name: "shot",
            fields: { path: "/tmp/a.png", event: "capture-1" },
            origin: { kind: "event", id: "capture-1" },
          }),
        ],
      }),
    );
    expect(rendered(compiled)).toContain(
      '<value unit="&quot;eV&quot;">a&lt;&amp;<b>x&gt;y</b></value>',
    );
    expect(compiled.contributions.some((entry) => entry.relation === "escaped")).toBe(true);
    covers(compiled);
    expect(compiled.semanticRegions.map((region) => region.kind)).toEqual(["xml", "xml", "marker"]);
  });
  it("elides Unicode characters without splitting a surrogate and attributes its marker", () => {
    const compiled = compilePrompt(
      Elide({ unit: "characters", limit: 2, marker: " [clipped]", children: ["😀a", "bc"] }),
    );
    expect(rendered(compiled)).toBe("😀a [clipped]");
    covers(compiled);
    expect(compiled.decisions.at(-1)).toMatchObject({
      kind: "elide",
      selected: "clipped",
      detail: { original: 4, omitted: 2 },
    });
    expect(compiled.contributions.at(-1)?.relation).toBe("generated");
  });
  it("preserves excluded content in the record and prevents unsafe math or media clipping", () => {
    const record = snapshot(Elide({ unit: "lines", limit: 1, children: "first\nsecond\nthird" }));
    expect(serializeRecord(record)).toContain("second");
    expect(rendered(rehydrate(record))).toBe("first…");
    expect(() =>
      compilePrompt(
        Elide({ unit: "characters", limit: 2, children: PromptMath({ value: "a+b" }) }),
      ),
    ).toThrow(/math\/XML/);
    expect(() =>
      compilePrompt(
        Elide({ unit: "characters", limit: 1, children: Image({ asset: { id: "a" } }) }),
      ),
    ).toThrow(/only accepts text/);
    const items = compilePrompt(
      Elide({
        unit: "items",
        limit: 1,
        children: [Image({ asset: { id: "a" } }), Image({ asset: { id: "b" } })],
      }),
    );
    expect(items.parts.map((part) => part.type)).toEqual(["image", "text"]);
    covers(items);
  });
  it("generates no separators for omitted or empty content and rejects unsupported heading depth", () => {
    expect(
      rendered(
        compilePrompt(Prompt({ children: ["a", null, false, Section({ title: "Empty" }), "b"] })),
      ),
    ).toBe("a\n\nb");
    let deep: PromptValue = "leaf";
    for (let i = 0; i < 7; i++) deep = Section({ title: "Section", children: deep });
    expect(() => compilePrompt(deep)).toThrow(/exceeds six/);
  });
});

describe("source and declaration projections", () => {
  it("retains template definition origin and placement origin independently", () => {
    const value = Text({ value: "known fact", origin: { kind: "event", id: "fact-7" } });
    const compiled = compilePrompt(
      Use({ value, key: "placement", origin: { kind: "source", file: "app.prompt.tsx", line: 4 } }),
    );
    expect(compiled.occurrences[0]).toMatchObject({
      origin: { kind: "source", line: 4 },
      definitionOrigin: { kind: "event", id: "fact-7" },
    });
  });
  it("handles classic key/spread fallbacks and never forwards compiler metadata to author props", () => {
    const propsSeen: unknown[] = [];
    const component = (props: { value: string; children?: PromptValue }) => {
      propsSeen.push(Object.keys(props));
      return props.children ?? props.value;
    };
    const automatic = jsx(
      component,
      { value: "a", key: "spread", __promptOrigin: { file: "a.prompt.tsx" } },
      "before-spread",
    );
    const classic = createElement(
      component,
      { value: "b", children: "old", key: "last" },
      "replacement",
    );
    expect(propsSeen).toEqual([["value"], ["value", "children"]]);
    expect(compilePrompt(automatic).occurrences[0].key).toBe("spread");
    expect(compilePrompt(classic).occurrences[0].key).toBe("last");
    expect(rendered(compilePrompt(classic))).toBe("replacement");
  });
  it("persists tool declarations once per projection value and re-derives budget decisions and field origins", () => {
    const tools = toolSnapshot(
      [
        {
          ns: "app",
          tools: [
            {
              name: "read",
              description: "Read current state. Additional context.",
              usage: "Supply the region ID.",
              kind: "read",
              inputSchema: { type: "object" },
            },
          ],
        },
      ],
      { registry: "page-1" },
    );
    const value = ToolBrief({ snapshot: tools, maxChars: 0 });
    const record = snapshot(value);
    const compiled = rehydrate(parseRecord(serializeRecord(record)));
    expect(serializeRecord(record)).toContain("Supply the region ID.");
    expect(rendered(compiled)).not.toContain("Supply the region ID.");
    expect(compiled.decisions).toContainEqual(
      expect.objectContaining({ kind: "tool-budget", selected: "required-over-budget" }),
    );
    expect(compiled.contributions.some((item) => item.origin?.snapshot === tools.fingerprint)).toBe(
      true,
    );
    expect(rendered(compilePrompt(CapabilityList({ snapshot: tools })))).toBe(
      "- read: Read current state.",
    );
    expect(JSON.parse(rendered(compilePrompt(ToolJson({ snapshot: tools }))))).toEqual(tools.kits);
    covers(compiled);
  });
  it("keeps tool capture and placement provenance separate from declaration identity", () => {
    const kits = [{ ns: "app", tools: [{ name: "read", description: "Read state." }] }];
    const first = toolSnapshot(kits, { site: "oracle" });
    const second = toolSnapshot(kits, { site: "live-session" });
    const record = snapshot(
      Prompt({
        children: [
          Use({
            value: ToolBrief({ snapshot: first }),
            key: "oracle",
            origin: { site: "first-placement" },
          }),
          Use({
            value: ToolBrief({ snapshot: second }),
            key: "live",
            origin: { site: "second-placement" },
          }),
        ],
      }),
    );
    const compiled = rehydrate(parseRecord(serializeRecord(record)));
    const captures = [first, second];
    for (const [index, key] of ["oracle", "live"].entries()) {
      const occurrence = compiled.occurrences.find((item) => item.key === key);
      expect(occurrence?.origin).toEqual({
        site: index === 0 ? "first-placement" : "second-placement",
      });
      const field = compiled.contributions.find(
        (item) => item.occurrence === occurrence?.id && item.origin?.field === "app/read/name",
      );
      expect(field?.origin).toEqual({
        kind: "tool-projection",
        snapshot: first.fingerprint,
        field: "app/read/name",
        capture: captures[index].origin,
      });
    }
    const records = captures.map((capture) => snapshot(ToolBrief({ snapshot: capture })));
    expect(records[0].fingerprint).not.toBe(records[1].fingerprint);
    expect(rehydrate(records[0]).parts).toEqual(rehydrate(records[1]).parts);
    const tampered = JSON.parse(serializeRecord(records[0]));
    tampered.definitions[0].toolSnapshot.origin.site = "rewritten";
    expect(() => parseRecord(tampered)).toThrow(/fingerprint/);
  });
  it("escapes plain section titles and preserves XML attribute whitespace", () => {
    expect(rendered(compilePrompt(Section({ title: "[x] * y", children: "body" })))).toBe(
      "# \\[x\\] \\* y\n\nbody",
    );
    expect(() => snapshot(Section({ title: "bad\nheading", children: "body" }))).toThrow(
      /single line/,
    );
    expect(rendered(compilePrompt(Xml({ tag: "x", attributes: { value: "a\tb\nc\rd" } })))).toBe(
      '<x value="a&#9;b&#10;c&#13;d"></x>',
    );
    expect(() => compilePrompt(Xml({ tag: "x", children: "bad\u0000" }))).toThrow(/XML 1.0/);
    expect(() => compilePrompt(Xml({ tag: "x", children: "bad\ud800" }))).toThrow(/XML 1.0/);
  });
});

describe("durable selectors and the schema-v1 fixture", () => {
  it("rejects unknown names and invalid placement addresses on every record entry point", () => {
    const value = Choice({ name: "background", children: "long", short: "short" });
    expect(() => snapshot(value, { selection: { backgroud: "short" } })).toThrow(
      /does not address/,
    );
    const record = snapshot(value);
    expect(() =>
      withRecordOptions(record, { selection: { "o/missing:background": "short" } }),
    ).toThrow(/does not address/);
    expect(() =>
      parseRecord(resign({ ...record, options: { selection: { "o:misspelled": "omit" } } })),
    ).toThrow(/does not address/);
  });
  it("preserves dormant named and scoped selections without running inactive branches", () => {
    const inner = Choice({ name: "detail", children: "full detail", short: "short detail" });
    const value = Case({
      name: "state",
      branches: [{ when: { op: "eq", path: "active", value: true }, value: inner }],
      fallback: "inactive",
    });
    const active = snapshot(value, { context: { active: true } });
    const choice = active.decisions.find((decision) => decision.kind === "choice");
    expect(choice).toBeDefined();
    const scoped = `${choice?.occurrence}:detail`;
    const dormant = withRecordOptions(active, {
      context: { active: false },
      selection: { detail: "full", [scoped]: "short" },
    });
    expect(rendered(rehydrate(dormant))).toBe("inactive");
    expect(rendered(rehydrate(withRecordOptions(dormant, { context: { active: true } })))).toBe(
      "short detail",
    );
    expect(() =>
      withRecordOptions(dormant, { selection: { [`${choice?.occurrence}/typo:detail`]: "short" } }),
    ).toThrow(/does not address/);
  });
  it("reads the committed first-version record and rederives its exact output without regenerating it", () => {
    const persisted = readFileSync(
      new URL("../test/fixtures/semantic-v1.json", import.meta.url),
      "utf8",
    );
    const record = parseRecord(persisted);
    expect(record.compiler.version).toBe("1.0.0");
    expect(record.schemaVersion).toBe(1);
    expect(record.decisions.map((decision) => decision.selected)).toEqual(["0", "short"]);
    expect(rehydrate(record).parts).toEqual([
      {
        id: "p0",
        type: "text",
        text: "Welcome.\n\nBrief background.\n\n$$\n\\hat{H}\\psi=E\\psi\n$$\n\n",
      },
      {
        id: "p1",
        type: "image",
        asset: { id: "plot-1", digest: "sha256:plot-fixture-v1", alt: "Energy plot" },
      },
    ]);
    covers(rehydrate(record));
  });
});

it("does not inherit Object.prototype properties as named selections", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const value = Choice({ name, children: "retained", short: "short" });
    const initial = snapshot(value);
    expect(rendered(rehydrate(parseRecord(serializeRecord(initial))))).toBe("retained");
    expect(initial.decisions[0].selected).toBe("full");
    const omitted = snapshot(value, { selection: { [name]: "omit" } });
    expect(rendered(rehydrate(parseRecord(serializeRecord(omitted))))).toBe("");
    expect(omitted.decisions[0].selected).toBe("omit");
    expect(Object.hasOwn(parseRecord(serializeRecord(omitted)).options.selection, name)).toBe(true);
  }
});

describe("mixed XML, Markdown, and bracket markers", () => {
  it("replays a structured transcript/request/tool document with global headings and one XML text escape", () => {
    const { value, tools } = mixedDelegation();
    const record = snapshot(value);
    const compiled = rehydrate(parseRecord(serializeRecord(record)));
    const output = rendered(compiled);
    expect(output).toContain('# Review\n\n<delegation id="own&lt;&amp;">## Recent conversation');
    expect(output).toContain(
      "user: Compare A &lt; B &amp; C.\nassistant: Use the &lt;raw&gt; sample.",
    );
    expect(output).toContain(
      '## Request\n\nCheck <sample label="A&amp;B">E &lt; 4 &amp; stable</sample> and report.',
    );
    expect(output).toContain("## Equation\n\n$$\n\\begin{aligned}a &amp;&lt; b\\end{aligned}\n$$");
    expect(output).toContain(
      "- analyze: Analyze values x &lt; y &amp; keep the units. Pass the sample ID; preserve &lt;limits&gt; as data.",
    );
    expect(output).not.toContain("&amp;amp;");
    expect(output).not.toContain("&lt;sample");
    expect(
      compiled.contributions.some(
        (entry) => entry.origin?.snapshot === tools.fingerprint && entry.relation === "escaped",
      ),
    ).toBe(true);
    expect(compiled.occurrences.some((entry) => entry.origin?.id === "speech-1")).toBe(true);
    const math = compiled.semanticRegions.find((region) => region.kind === "math");
    expect(math).toBeDefined();
    expect(output.slice(math?.start, math?.end)).toContain("&amp;&lt;");
    covers(compiled);
    expect(serializeRecord(record)).toContain("Compare A < B & C.");
  });
  it("does not cut escaped entities when clipping XML text and maps final emitted lengths", () => {
    const compiled = compilePrompt(
      Xml({
        tag: "value",
        children: Elide({ unit: "characters", limit: 1, marker: "<omitted>", children: "&x" }),
      }),
    );
    expect(rendered(compiled)).toBe("<value>&amp;&lt;omitted&gt;</value>");
    expect(compiled.decisions.at(-1)).toMatchObject({
      kind: "elide",
      detail: { original: 2, limit: 1, omitted: 1, scope: "content-before-xml-text-escaping" },
    });
    const authored = compiled.contributions.find((entry) => entry.relation === "escaped");
    expect((authored?.end ?? 0) - (authored?.start ?? 0)).toBe(5);
    covers(compiled);
    expect(rendered(compilePrompt(Xml({ tag: "value", children: "&lt;" })))).toBe(
      "<value>&amp;lt;</value>",
    );
    expect(
      rendered(
        compilePrompt(
          Xml({ tag: "value", children: Join({ separator: " & ", children: ["a", "b"] }) }),
        ),
      ),
    ).toBe("<value>a &amp; b</value>");
  });
  it("retains Marker child structure and field/event provenance through JSON replay", () => {
    const marker = Marker({
      name: "current tab changed:",
      fields: { event: "navigation-7" },
      origin: { kind: "captured-event", id: "navigation-7" },
      children: Xml({
        tag: "tab",
        attributes: { id: "t&7" },
        children: Text({ value: "A < B", origin: { kind: "tab-capture", id: "t7" } }),
      }),
    });
    const record = snapshot(marker);
    const compiled = rehydrate(parseRecord(serializeRecord(record)));
    expect(rendered(compiled)).toBe(
      '[current tab changed: event="navigation-7" <tab id="t&amp;7">A &lt; B</tab>]',
    );
    expect(compiled.semanticRegions.map((region) => region.kind)).toEqual(["xml", "marker"]);
    expect(compiled.occurrences.some((occurrence) => occurrence.origin?.id === "t7")).toBe(true);
    expect(compiled.occurrences[0].origin?.id).toBe("navigation-7");
    covers(compiled);
    const nested = compilePrompt(Xml({ tag: "event", children: marker }));
    expect(rendered(nested)).toBe(
      '<event>[current tab changed: event="navigation-7" <tab id="t&amp;7">A &lt; B</tab>]</event>',
    );
    covers(nested);
  });
  it("preserves old field-only Marker records and refuses media without an explicit text policy", () => {
    const record = snapshot(Marker({ name: "shot", fields: { path: "a.png" } }));
    expect(record.definitions[0]).not.toHaveProperty("children");
    expect(rendered(rehydrate(parseRecord(serializeRecord(record))))).toBe('[shot path="a.png"]');
    expect(() =>
      compilePrompt(Marker({ name: "shot", children: Image({ asset: { id: "plot" } }) })),
    ).toThrow(/textual asset projection/);
    expect(() =>
      compilePrompt(Xml({ tag: "shot", children: Image({ asset: { id: "plot" } }) })),
    ).toThrow(/explicit textual projection/);
    expect(() =>
      parseRecord(
        resign({ ...record, definitions: [{ ...record.definitions[0], children: "bad" }] }),
      ),
    ).toThrow(/children array/);
  });
});
