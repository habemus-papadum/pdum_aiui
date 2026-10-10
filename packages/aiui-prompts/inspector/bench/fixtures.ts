import {
  Case,
  Choice,
  Math as Formula,
  Image,
  Marker,
  Prompt,
  Section,
  snapshot,
  Text,
  ToolBrief,
  toolSnapshot,
  Use,
  Xml,
} from "../../src/index.ts";

/** Manual origin metadata is explicit; no compiler-captured location is claimed here. */
const origin = { kind: "example", label: "inspector/bench/fixtures.ts", capture: "manual" };

const guidance = Section({
  title: "Scientific checks",
  label: "Reusable checks",
  origin,
  children: [
    Text({
      value: "Check **dimensions**, state assumptions, and preserve exact symbols.",
      label: "Checks",
    }),
    Choice({
      name: "background",
      label: "Background choice",
      children: "Use SI units throughout. Explain boundary conditions and limiting cases.",
      short: "Use SI units.",
    }),
  ],
});

export const scientificPrompt = Prompt({
  label: "Scientific session",
  origin,
  children: [
    Section({
      title: "Session instructions",
      label: "Instructions",
      children: [
        Case({
          name: "session-phase",
          label: "Recorded session decision",
          branches: [
            {
              when: { op: "eq", path: "session.reason", value: "start" },
              label: "First start",
              value: "Introduce the task and ask which approximation the reader wants to explore.",
            },
            {
              when: { op: "eq", path: "session.reason", value: "reconnect" },
              label: "Reconnect",
              value:
                "Resume without repeating the introduction. Ask what changed while disconnected.",
            },
          ],
          fallback: "Continue from the existing discussion. Describe only the new evidence.",
        }),
      ],
    }),
    Section({
      title: "Hamiltonian",
      label: "Hamiltonian section",
      children: [
        "Explain the model for α and the state 🧪; compare its energy to the data.",
        Formula({
          mode: "display",
          label: "Split equation",
          children: [
            Text({ value: String.raw`\hat H = `, label: "Hamiltonian symbol", origin }),
            Text({ value: String.raw`\frac{\hat p^2}{2m}`, label: "Kinetic term", origin }),
            Text({ value: String.raw` + V(\hat x)`, label: "Potential term", origin }),
          ],
        }),
        Use({ value: guidance, key: "theory", label: "Theory checks" }),
      ],
    }),
    Image({
      label: "Captured plot",
      asset: {
        id: "example:energy-plot",
        uri: "asset:energy-plot",
        mimeType: "image/png",
        alt: "Illustrative energy plot",
        metadata: { capture: "synthetic local fixture" },
      },
    }),
    Section({
      title: "Compare measurements",
      label: "Measurement section",
      children: [
        "| Trial | Energy |\n| --- | --- |\n| A | 1.25 |\n| B | 1.31 |",
        Use({ value: guidance, key: "experiment", label: "Experiment checks" }),
      ],
    }),
  ],
});

export function exampleRecord(reason: "start" | "reconnect" | "refresh" = "start") {
  return snapshot(scientificPrompt, {
    context: { session: { reason, turns: reason === "start" ? 0 : 4 } },
  });
}

export const textOnlyPrompt = Prompt({
  label: "Exact text and Markdown",
  children: [
    Section({ title: "Reader", children: "A &amp; B, **bold**, and `literal <code>`." }),
    Text({ value: "Unicode: 🧪 α.\r\nA Windows line ending is retained in raw output." }),
  ],
});

/** New synthetic compositions; these are not legacy corpus byte-parity fixtures. */
export const laboratoryTools = toolSnapshot(
  [
    {
      ns: "lab",
      brief: "Workbench tools for synthetic laboratory runs.",
      tools: [
        {
          name: "read_run",
          description: "Read one recorded laboratory run.",
          kind: "read",
          group: "Observations",
          inputSchema: {
            type: "object",
            properties: { runId: { type: "string" } },
            required: ["runId"],
          },
          usage:
            "Supply the run identifier shown beside the plot. The result contains calibrated measurements, acquisition units, and the recorded uncertainty for every observation; preserve those units when comparing runs.",
        },
        {
          name: "set_plan",
          description: "Store a proposed analysis plan.",
          kind: "write",
          group: "Plans",
          inputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
          usage: "Use a short summary naming the approximation and the measurements it applies to.",
        },
      ],
    },
  ],
  {
    kind: "tool-registry-capture",
    eventId: "synthetic:tools:7",
    namespace: "lab",
    revision: "fixture-1",
  },
);

export const delegationPrompt = Prompt({
  label: "Synthetic delegation composition",
  origin,
  children: [
    Section({
      title: "Delegate a laboratory comparison",
      children:
        "Prepare a concise comparison; the structured envelope below contains the task and available tools.",
    }),
    Xml({
      tag: "delegation",
      attributes: { id: "synthetic-task-7", backend: "responses" },
      label: "Delegation envelope",
      origin: { kind: "event", eventId: "synthetic:delegation:7", capture: "workbench" },
      children: Prompt({
        children: [
          Section({
            title: "Task",
            label: "Delegated task",
            children: [
              Text({
                value:
                  "Compare **run A** with **run B**; report values with energy < 3.5 & calibrated units.",
                label: "Task text",
              }),
              Formula({
                value: String.raw`E = \frac{p^2}{2m}`,
                mode: "display",
                label: "Delegated formula",
              }),
            ],
          }),
          Section({
            title: "Available tools",
            label: "Tool declarations",
            children: ToolBrief({
              snapshot: laboratoryTools,
              qualify: true,
              maxChars: 540,
              label: "Budgeted laboratory tools",
            }),
          }),
        ],
      }),
    }),
  ],
});

const tabEvent = {
  kind: "event",
  eventId: "synthetic:tab-switch:42",
  captureRegion: "viewport",
  capture: "workbench",
};

export const markerSidecarPrompt = Prompt({
  label: "Synthetic tab event and sidecar",
  origin: tabEvent,
  children: [
    Marker({
      name: "current tab changed:",
      fields: { tabId: "synthetic-42" },
      label: "Captured tab marker",
      origin: tabEvent,
      children: Xml({
        tag: "tab",
        attributes: {
          id: "synthetic-42",
          url: "https://example.invalid/laboratory?run=42&view=summary",
        },
        label: "Tab sidecar",
        origin: tabEvent,
        children: [
          Xml({ tag: "title", children: "Synthetic measurements" }),
          Xml({
            tag: "selection",
            attributes: { region: "filter-panel" },
            label: "Captured selection",
            children: Text({
              value: "Filter: energy < 3.5 & status = 'ready'",
              origin: { ...tabEvent, captureRegion: "filter-panel" },
              label: "Selection text",
            }),
          }),
        ],
      }),
    }),
    Case({
      name: "page-alignment",
      label: "Recorded page capability",
      branches: [
        {
          when: { op: "eq", path: "page.isAiui", value: true },
          label: "App tools available",
          value: "Inspect the declared app tools before changing the analysis view.",
        },
      ],
      fallback: "Inspect the visible browser controls before changing the analysis view.",
    }),
  ],
});

export function delegationRecord() {
  return snapshot(delegationPrompt, {
    context: { delegation: { backend: "responses", task: "synthetic-task-7" } },
  });
}

export function markerSidecarRecord() {
  return snapshot(markerSidecarPrompt, {
    context: { page: { isAiui: true, tabId: "synthetic-42" } },
  });
}
