/** Owned mixed-document fixture. No legacy renderer or corpus output is imported. */
import {
  Group,
  Join,
  Paragraph,
  Prompt,
  Math as PromptMath,
  Section,
  Text,
  ToolBrief,
  Xml,
} from "../../src/model.ts";
import { toolSnapshot } from "../../src/tools-data.ts";

export function mixedDelegation() {
  const tools = toolSnapshot(
    [
      {
        ns: "laboratory",
        brief: "Analyze bounded measurements & report uncertainty.",
        tools: [
          {
            name: "analyze",
            description: "Analyze values x < y & keep the units.",
            usage: "Pass the sample ID; preserve <limits> as data.",
            kind: "read",
            inputSchema: { type: "object", properties: { sample: { type: "string" } } },
          },
        ],
      },
    ],
    { kind: "tool-registry", id: "synthetic-registry-1" },
  );
  const value = Prompt({
    children: Section({
      title: "Review",
      children: Xml({
        tag: "delegation",
        attributes: { id: "own<&" },
        children: Prompt({
          children: [
            Section({
              title: "Recent conversation",
              children: Join({
                separator: "\n",
                children: [
                  Paragraph({
                    children: [
                      "user: ",
                      Text({
                        value: "Compare A < B & C.",
                        origin: { kind: "captured-event", id: "speech-1" },
                      }),
                    ],
                  }),
                  Paragraph({
                    children: [
                      "assistant: ",
                      Text({
                        value: "Use the <raw> sample.",
                        origin: { kind: "captured-event", id: "speech-2" },
                      }),
                    ],
                  }),
                ],
              }),
            }),
            Section({
              title: "Request",
              children: Group({
                children: [
                  "Check ",
                  Xml({ tag: "sample", attributes: { label: "A&B" }, children: "E < 4 & stable" }),
                  " and report.",
                ],
              }),
            }),
            Section({
              title: "Equation",
              children: PromptMath({
                children: [
                  String.raw`\begin{aligned}a `,
                  Text({
                    value: String.raw`&< b\end{aligned}`,
                    origin: { kind: "data", id: "equation-1" },
                  }),
                ],
              }),
            }),
            Section({ title: "Available tools", children: ToolBrief({ snapshot: tools }) }),
          ],
        }),
      }),
    }),
  });
  return { value, tools };
}
