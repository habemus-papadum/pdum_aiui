/**
 * The CORPUS of what this package sends and teaches, as readable files under
 * ../corpus/ — a baseline for the prompt-toolkit migration, not a contract
 * (docs/proposals/structured-prompts-review.md). `vitest -u` updates; review the diff.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeIntent, type IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { describe, expect, it } from "vitest";
import { STALE_NOTICE } from "./hot";
import { LINTER_INSTRUCTIONS } from "./live-session";
import { promptContextSections, TRANSCRIPTION_NOTE, wrapWithContextParts } from "./prompt-context";
import { INSTRUCTIONS } from "./server";
import { SUMMARY_SYSTEM_PROMPT, summaryPromptInput } from "./summarize";

const corpus = (name: string): string => join(__dirname, "..", "corpus", name);
const fixture = (name: string): IntentEvent[] =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "..", "aiui-lowering-pipeline", "fixtures", name), "utf8"),
  ) as IntentEvent[];

const aiuiHello = {
  tab: {
    url: "http://localhost:5173/seismos",
    title: "seismos — aiui demo app",
    chromeTabId: 42,
    windowId: 1,
    tabIndex: 3,
  },
  source: { root: "/Users/someone/src/app" },
  cdp: { state: "aligned" },
} as never;
const bareHello = { tab: { url: "https://example.com/docs", title: "Docs" } } as never;

describe("corpus: the channel's prompt text", () => {
  it("the preamble for an aiui app, and for a bare page", async () => {
    await expect(promptContextSections(aiuiHello).join("\n\n")).toMatchFileSnapshot(
      corpus("preamble-aiui-app.txt"),
    );
    await expect(promptContextSections(bareHello).join("\n\n")).toMatchFileSnapshot(
      corpus("preamble-bare.txt"),
    );
  });

  it("a whole lowered prompt: preamble, transcription note, the fixture's body", async () => {
    const body = composeIntent(fixture("full-turn-send.json"), "replace").prompt;
    const { text } = wrapWithContextParts(
      [...promptContextSections(aiuiHello), TRANSCRIPTION_NOTE],
      body,
    );
    await expect(text).toMatchFileSnapshot(corpus("lowered-prompt-full-turn-send.txt"));
    await expect(
      `${SUMMARY_SYSTEM_PROMPT}\n\n---\n\n${summaryPromptInput(body)}`,
    ).toMatchFileSnapshot(corpus("summary-input-full-turn-send.txt"));
  });

  it("the standing texts: the MCP instructions, the linter persona, the stale notice", async () => {
    await expect(INSTRUCTIONS).toMatchFileSnapshot(corpus("mcp-instructions.txt"));
    await expect(LINTER_INSTRUCTIONS).toMatchFileSnapshot(corpus("linter-instructions.txt"));
    await expect(STALE_NOTICE).toMatchFileSnapshot(corpus("stale-notice.txt"));
  });
});
