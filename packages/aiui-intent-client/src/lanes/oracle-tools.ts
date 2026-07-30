/**
 * oracle-tools.ts — the oracle's two NON-page tool groups (O3c,
 * docs/proposals/intent-oracle.md). The page's own tools live in
 * `oracle.ts`/`page-tools.ts`; these are the panel's and the project's.
 *
 *  - **files** — `read_file`, `list_files`, `grep`, executed CHANNEL-side over
 *    `POST /intent/oracle/tool`. The oracle runs in the browser and talks
 *    WebRTC straight to the vendor, so a filesystem is not reachable from
 *    here; the sidecar route is the crossing, and the policy behind it is the
 *    prompt linter's own (one implementation, two advertised subsets).
 *  - **panel** — the command bar itself: `panel_bar_list` reads it,
 *    `panel_bar_dispatch` presses a cap. Writeable by owner decision
 *    (2026-07-30), which is why the permission is DECLARED per cap rather
 *    than deny-listed: see `oracle?: boolean` in caps.ts.
 *
 * Every result is JSON-stringified into the vendor's `function_call_output` by
 * the session, and every call and result lands in the oracle's ledger — which
 * is what keeps the file reads as visible as the linter's are in the trace.
 */

import type { OracleTool } from "@habemus-papadum/aiui-oracle";
import type { BarItem } from "@habemus-papadum/aiui-viz/modal";
import { intentBar } from "../caps";
import type { IntentClient } from "../client";

/** What the sidecar route answers with (the channel's `ReadFileResult`). */
interface ToolOutcome {
  ok: boolean;
  content: string;
  summary: string;
}

export interface FileToolsOptions {
  /** The bound channel port; absent = same-origin (the channel serves us). */
  port: () => number | undefined;
  fetchImpl?: typeof fetch;
}

/** The three local-read tools, each a POST to the sidecar's one route. */
export function fileTools(options: FileToolsOptions): OracleTool[] {
  const call = async (tool: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const port = options.port();
    const url =
      port === undefined ? "/intent/oracle/tool" : `http://127.0.0.1:${port}/intent/oracle/tool`;
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    if (!response.ok) {
      // A transport-level failure still has to READ as an answer — the vendor
      // gives tools no error channel, so a throw would just become an opaque
      // `{error}` the model cannot act on.
      return {
        ok: false,
        content: `${tool} is unavailable (channel answered ${response.status})`,
        summary: `http ${response.status}`,
      };
    }
    return (await response.json()) as ToolOutcome;
  };

  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
  ): OracleTool => ({
    name,
    description,
    parameters,
    execute: async (args) => {
      const outcome = await call(name, args);
      // The CONTENT is what the model reads; `ok` lets it tell "no matches"
      // from "that path does not exist" without parsing prose.
      return { ok: outcome.ok, result: outcome.content };
    },
  });

  return [
    tool(
      "read_file",
      "Read a file from the project the user is working on. Relative paths resolve against " +
        "the project root. Text files only; large files are truncated with a marker.",
      {
        type: "object",
        properties: { path: { type: "string", description: "File path, relative or absolute." } },
        required: ["path"],
        additionalProperties: false,
      },
    ),
    tool(
      "list_files",
      "List files and directories under a path in the project, to find what to read. " +
        "Results are capped and say so.",
      {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory, relative or absolute." },
          depth: { type: "number", description: "Levels to descend (default 1, max 5)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    ),
    tool(
      "grep",
      "Search the project's text files for a regular expression; returns matching lines with " +
        "file and line number. Use it to locate code before reading it. Results are capped.",
      {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: { type: "string", description: "Directory or file to search." },
          extensions: {
            type: "array",
            items: { type: "string" },
            description: 'Limit to these extensions, e.g. ["ts","tsx"].',
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    ),
  ];
}

/**
 * The caps the oracle may press, gathered from the bar declaration itself.
 * Walking `intentBar` (rather than listing names here) is what makes the
 * permission live where the affordance does — a cap added without the flag is
 * excluded by default, which is the property a deny-list cannot offer.
 */
function oracleCapCommands(): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly (typeof intentBar)[number][]): void => {
    for (const node of nodes) {
      if (node.kind === "widget") {
        continue;
      }
      if (node.oracle === true) {
        out.add(node.command);
      }
      if (node.children !== undefined) {
        walk(node.children as readonly (typeof intentBar)[number][]);
      }
    }
  };
  walk(intentBar);
  return out;
}

/** The bar's depth-first forest as a flat item list — what the panel renders
 * linearly, and what the oracle must be shown. */
function flattenBar(nodes: ReturnType<IntentClient["bar"]>): BarItem[] {
  return nodes.flatMap((node) => [node.item, ...flattenBar(node.children)]);
}

/** The panel's own bar, readable and pressable (owner, 2026-07-30). */
export function panelTools(client: IntentClient): OracleTool[] {
  const allowed = oracleCapCommands();
  return [
    {
      name: "panel_bar_list",
      description:
        "List the aiui intent panel's own controls: each button's command, label, whether it " +
        "is currently enabled, whether it is engaged, and its keyboard shortcut. Call this to " +
        "answer questions about the panel itself, or before pressing anything.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      // `client.bar()` is a depth-first TREE, not a list: the turn cap and
      // everything else live under `arm`'s children, and a revealed child only
      // appears while its parent is lit. Flattening is what the panel's own
      // renderer does, and skipping it handed the oracle three root caps and
      // called that the panel (found by test).
      execute: () =>
        flattenBar(client.bar()).map((item) => {
          if (item.kind === "widget") {
            return { setting: item.control, label: item.label, enabled: item.enabled };
          }
          return {
            command: item.command,
            label: item.hint.label,
            key: item.hint.key === "" ? undefined : item.hint.key,
            enabled: item.enabled,
            engaged: item.lit,
            // Say plainly what it may not touch, so it explains rather than
            // tries and is refused.
            youMayPress: allowed.has(item.command),
          };
        }),
    },
    {
      name: "panel_bar_dispatch",
      description:
        "Press one of the panel's controls by its command name. Only the controls whose " +
        "`youMayPress` is true in panel_bar_list can be pressed — the turn's lifecycle " +
        "(sending, cancelling), arming, and the microphone are the user's alone.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The cap's command name." } },
        required: ["command"],
        additionalProperties: false,
      },
      execute: (args) => {
        const command = typeof args.command === "string" ? args.command : "";
        // TWO gates, and they answer different questions. The flag is
        // "never" — a standing property of the affordance, declared beside it.
        // `canDispatch` is "not right now" — the machine's own availability,
        // the same gate a cap tap or a key meets.
        if (!allowed.has(command)) {
          return {
            ok: false,
            refused: `"${command}" is not a control the oracle may press`,
          };
        }
        if (!client.canDispatch(command)) {
          return { ok: false, refused: `"${command}" is not available right now` };
        }
        client.dispatch(command);
        return { ok: true, pressed: command };
      },
    },
  ];
}
