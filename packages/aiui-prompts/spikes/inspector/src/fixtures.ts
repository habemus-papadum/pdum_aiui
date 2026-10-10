import type { Artifact, Fixture, ImagePart, Occurrence } from "./model";
import { textPart } from "./model";

function occurrence(
  id: string,
  label: string,
  startLine: number,
  endLine = startLine,
  parent = "prompt",
  definition = id,
): Occurrence {
  return {
    id,
    label,
    parent: id === "prompt" ? undefined : parent,
    definition,
    source: { file: "example.prompt.tsx", startLine, endLine },
  };
}

function artifact(
  id: string,
  revision: string,
  source: string,
  occurrences: Occurrence[],
  parts: Artifact["parts"],
): Artifact {
  return {
    id,
    revision,
    sources: { "example.prompt.tsx": source },
    occurrences,
    parts,
    instructions: "Explain the evidence. Preserve equations and measurement precision.",
    history:
      id === "scientific" ? { kind: "conversation", id: "thread-fixture-42" } : { kind: "none" },
  };
}

function image(revised: boolean): ImagePart {
  // A local generated illustration; no network request or real scientific measurement.
  const path = revised
    ? "M40 125 Q90 35 140 115 T240 90 T340 65"
    : "M40 130 Q90 20 140 125 T240 100 T340 80";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="180" viewBox="0 0 380 180"><rect width="380" height="180" fill="#f7fafc"/><path d="M40 20V150H355" fill="none" stroke="#5b6674"/><path d="${path}" fill="none" stroke="#315b9e" stroke-width="3"/><text x="45" y="18" font-family="sans-serif" font-size="12">Amplitude (a.u.)</text><text x="295" y="170" font-family="sans-serif" font-size="12">Time (s)</text><text x="240" y="32" font-family="sans-serif" font-size="12">Fixture ${revised ? "B" : "A"}</text></svg>`;
  return {
    kind: "image",
    id: "plot-part",
    owner: "plot",
    asset: {
      id: "decay-plot",
      revision: revised ? "drawing-b" : "drawing-a",
      alt: "Illustrative damped oscillation",
      uri: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      width: 380,
      height: 180,
    },
  };
}

function scientific(revised: boolean): Artifact {
  const source = [
    "const numerator = tex`a`;",
    "const denominator = tex`b`;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Display the fixture's literal TSX source.
    "const ratio = <Math display>{tex`\\frac{${numerator}}{${denominator}}`}</Math>;",
    'const evidence = <Section title="Scientific evidence">',
    "  <Paragraph>Preserve units, significant zeros, and the exact equation.</Paragraph>",
    "  {ratio}",
    "  <Math display>{tex`\\begin{aligned} E &= mc^2 \\\\ \\Delta E &= c^2\\Delta m \\end{aligned}`}</Math>",
    "  <Paragraph>Inspect this measured response:</Paragraph>",
    '  <Image asset={plot} alt="Illustrative damped oscillation" />',
    `  <Paragraph>${revised ? "Explain the damping, then state uncertainty." : "Describe the response, then state uncertainty."}</Paragraph>`,
    "</Section>;",
  ].join("\n");
  const o = [
    occurrence("prompt", "Scientific evidence", 4, 11),
    occurrence("intro", "Instructions", 5),
    occurrence("ratio", "Shared equation", 3),
    occurrence("numerator", "Numerator + generated syntax", 1, 1, "ratio"),
    occurrence("denominator", "Denominator + generated syntax", 2, 2, "ratio"),
    occurrence("energy", "Aligned TeX", 7),
    occurrence("lead", "Text before image", 8),
    occurrence("plot", "Damped response image", 9),
    occurrence("question", "Text after image", 10),
  ];
  o[3].origin = "Illustrative equation input A; surrounding TeX syntax is fixture-owned.";
  o[4].origin = "Illustrative equation input B; anchor precision is whole equation.";
  return artifact("scientific", revised ? "B" : "A", source, o, [
    textPart("equations", [
      ["prompt", "# Scientific evidence\n\n"],
      ["intro", "Preserve **units**, significant zeros, and the exact equation.\n\n"],
      ["numerator", "$$\n\\frac{a}{"],
      ["denominator", "b}\n$$\n\n"],
      [
        "energy",
        "$$\n\\begin{aligned}\nE &= mc^2 \\\\\n\\Delta E &= c^2\\Delta m\n\\end{aligned}\n$$\n\n",
      ],
      ["lead", "Inspect this measured response:\n\n"],
    ]),
    image(revised),
    textPart("question", [
      [
        "question",
        `\n\n${revised ? "Explain the damping" : "Describe the response"}, then state uncertainty.\n`,
      ],
    ]),
  ]);
}

function reusable(revised: boolean): Artifact {
  const source = [
    'const evidence = <Section title="Evidence">',
    '  <Paragraph>{"A &amp; B observed the same **signal**."}</Paragraph>',
    "</Section>;",
    'const task = <Section title="Investigation">',
    '  <Use key="primary" fragment={evidence} />',
    '  <Section title="Independent check">',
    '    <Use key="repeated" fragment={evidence} />',
    "  </Section>",
    `  {${revised ? "false" : "true"} && <Paragraph>Optional background: keep the original calibration.</Paragraph>}`,
    "</Section>;",
  ].join("\n");
  const o = [
    occurrence("prompt", "Investigation", 4, 10),
    occurrence("primary", "Evidence · first placement", 5, 5, "prompt", "evidence"),
    occurrence("primary-text", "Evidence text · first", 2, 2, "primary", "evidence-text"),
    occurrence("check", "Independent check", 6, 8),
    occurrence("repeat", "Evidence · second placement", 7, 7, "check", "evidence"),
    occurrence("repeat-text", "Evidence text · second", 2, 2, "repeat", "evidence-text"),
  ];
  if (!revised) o.push(occurrence("background", "Optional background", 9));
  return artifact("reusable", revised ? "B · background omitted" : "A · full", source, o, [
    textPart("body", [
      ["prompt", "# Investigation\n\n"],
      ["primary", "## Evidence\n\n"],
      ["primary-text", "A &amp; B observed the same **signal**.\n\n"],
      ["check", "## Independent check\n\n"],
      ["repeat", "### Evidence\n\n"],
      ["repeat-text", "A &amp; B observed the same **signal**.\n\n"],
      ...(!revised
        ? [["background", "Optional background: keep the original calibration.\n"] as const]
        : []),
    ]),
  ]);
}

function table(revised: boolean): Artifact {
  const source = [
    "const rows = measurements.map((m) => ({ ...m, value: lexical(m.value) }));",
    'const task = <Section title="Measurement report">',
    "  <Paragraph>Compare precision without rounding the supplied values.</Paragraph>",
    '  <Table columns={["Run", "Mass (kg)", "Uncertainty"]}>',
    '    <Row key="run-a"><Cell>A</Cell><Cell>{rows[0].value}</Cell><Cell>0.0020</Cell></Row>',
    `    <Row key="run-b"><Cell>B</Cell><Cell>${revised ? "1.2400" : "1.2300"}</Cell><Cell>0.0030</Cell></Row>`,
    "  </Table>",
    '  <Code language="python">{`residual = observed - predicted`}</Code>',
    "</Section>;",
  ].join("\n");
  return artifact(
    "table",
    revised ? "B" : "A",
    source,
    [
      occurrence("prompt", "Measurement report", 2, 9),
      occurrence("intro", "Precision instruction", 3),
      occurrence("table", "Measurements table", 4, 7),
      occurrence("header", "Column headings", 4, 4, "table"),
      occurrence("row-a", "Run A", 5, 5, "table"),
      occurrence("cell-a", "A mass · lexical value", 5, 5, "row-a"),
      occurrence("row-b", "Run B", 6, 6, "table"),
      occurrence("cell-b", "B mass · lexical value", 6, 6, "row-b"),
      occurrence("code", "Residual code", 8),
    ],
    [
      textPart("body", [
        ["prompt", "# Measurement report\n\n"],
        ["intro", "Compare precision without rounding the supplied values.\n\n"],
        ["header", "| Run | Mass (kg) | Uncertainty |\n| --- | ---: | ---: |\n"],
        ["row-a", "| A | "],
        ["cell-a", "1.2300"],
        ["row-a", " | 0.0020 |\n"],
        ["row-b", "| B | "],
        ["cell-b", revised ? "1.2400" : "1.2300"],
        ["row-b", " | 0.0030 |\n\n"],
        ["code", "```python\nresidual = observed - predicted\n```\n"],
      ]),
    ],
  );
}

function greeting(revised: boolean): Artifact {
  return artifact(
    "greeting",
    revised ? "B" : "A",
    [
      `const name = ${JSON.stringify(revised ? "Ada" : "Grace")};`,
      "const task = <Paragraph>Hello, {name}! Explain one useful scientific idea.</Paragraph>;",
    ].join("\n"),
    [occurrence("prompt", "Greeting", 2), occurrence("name", "Name interpolation", 1)],
    [
      textPart("body", [
        ["prompt", "Hello, "],
        ["name", revised ? "Ada" : "Grace"],
        ["prompt", "! Explain one useful scientific idea.\n"],
      ]),
    ],
  );
}

export const fixtures: Fixture[] = [
  {
    id: "greeting",
    title: "01 · Greeting & interpolation",
    note: "A short paragraph has three raw ranges and two contributors. Select the formatted paragraph to inspect both.",
    before: greeting(false),
    after: greeting(true),
  },
  {
    id: "reusable",
    title: "02 · Reuse, headings & omission",
    note: "One evidence definition is placed at two depths. Fold each placement independently. Revision B omits optional background; history is unchanged.",
    before: reusable(false),
    after: reusable(true),
  },
  {
    id: "scientific",
    title: "03 · Math, image & shared ownership",
    note: "Fold only the numerator: its raw range folds, but the intact equation stays visible with a partial-fold badge. The image is between two text parts.",
    before: scientific(false),
    after: scientific(true),
  },
  {
    id: "table",
    title: "04 · Table, precision & code",
    note: "Fold a single mass cell: raw folds precisely, while the valid table retains a coarse preview and exposes its contributors. Values preserve significant zeros.",
    before: table(false),
    after: table(true),
  },
  {
    id: "comparison",
    title: "05 · Before / after inspection",
    note: "Compare two complete documents: changed image content has the same dimensions and alt text. Each side parses separately; no diff markers enter TeX.",
    before: scientific(false),
    after: scientific(true),
  },
];
