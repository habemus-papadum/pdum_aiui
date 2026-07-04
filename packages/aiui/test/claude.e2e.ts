/**
 * The one true end-to-end test for `aiui claude`.
 *
 * It really is end-to-end: it launches a real Claude Code session (Haiku,
 * headless-in-tmux), pushes a prompt through the custom MCP channel using the
 * *library* form of `quick` (`sendPromptByTag`), waits for Claude to answer, and
 * checks that shutdown cleans up the registry. Everything else about the system
 * we test at the component level; this proves the pieces connect.
 *
 * Marker: this file is `*.e2e.ts`, so the default `pnpm test` never collects it.
 * Run it with `pnpm test:e2e` (see vitest.e2e.config.ts). It also skips itself
 * gracefully when `tmux`/`claude` aren't available.
 *
 * Prerequisites: `tmux` + `claude` on PATH, working Claude auth (a subscription
 * login or CLAUDE_CODE_OAUTH_TOKEN), and a built workspace (`pnpm build`) so the
 * channel library resolves.
 */
import { randomUUID } from "node:crypto";
import { sendPromptByTag } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";
import { claudeAvailable, launchClaudeSession, tmuxAvailable } from "./harness";

const canRun = tmuxAvailable() && claudeAvailable();

describe.skipIf(!canRun)("aiui claude · channel round-trip (e2e)", () => {
  it("answers a channel prompt on Haiku, then cleans up on exit", async () => {
    const tag = randomUUID();

    // 1) Start Claude Code with the tag + Haiku, in JSON-less interactive mode
    //    inside tmux (the channel only reaches an interactive session).
    const session = await launchClaudeSession({ tag, model: "haiku" });

    try {
      // 2) Use the library form of `quick` to send the prompt over the channel.
      const sent = await sendPromptByTag(
        tag,
        "What is the capital of France? Answer in one short sentence.",
      );
      expect(sent.ok).toBe(true);

      // 3) Claude, driven by the channel event, answers — and it's on Haiku
      //    (the model is shown in the session UI).
      const answered = await session.waitForText(/paris/i, 90_000);
      expect(answered).toBe(true);
      expect(session.capture()).toMatch(/haiku/i);

      // 4) On shutdown, the channel server removes its registry entry.
      await session.stop();
      expect(session.findServer()).toBeUndefined();
    } finally {
      await session.dispose();
    }
  }, 150_000);
});
