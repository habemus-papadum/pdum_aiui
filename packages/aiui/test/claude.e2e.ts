/**
 * The one true end-to-end test for `aiui claude`.
 *
 * It really is end-to-end: it launches a real Claude Code session (Haiku,
 * headless-in-tmux), pushes prompts through the custom MCP channel using the
 * *library* forms of `quick` — over both transports the channel speaks, the
 * `POST /prompt` path (`sendPromptByTag`) and the `/ws` stream-processor path
 * (`sendPromptWsByTag`) — waits for Claude to answer each, and checks that
 * shutdown cleans up the registry. Everything else about the system we test at
 * the component level; this proves the pieces connect.
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
import { sendPromptByTag, sendPromptWsByTag } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";
import { claudeAvailable, launchClaudeSession, tmuxAvailable } from "./harness";

const canRun = tmuxAvailable() && claudeAvailable();

describe.skipIf(!canRun)("aiui claude · channel round-trip (e2e)", () => {
  it("answers channel prompts over both transports on Haiku, then cleans up on exit", async () => {
    const tag = randomUUID();

    // 1) Start Claude Code with the tag + Haiku, in JSON-less interactive mode
    //    inside tmux (the channel only reaches an interactive session).
    const session = await launchClaudeSession({ tag, model: "haiku" });

    try {
      // 2) HTTP path: send a prompt via the `POST /prompt` library helper.
      const sentHttp = await sendPromptByTag(
        tag,
        "What is the capital of France? Answer in one short sentence.",
      );
      expect(sentHttp.ok).toBe(true);

      // 3) Claude, driven by the channel event, answers — and it's on Haiku
      //    (the model is shown in the session UI).
      const answeredFrance = await session.waitForText(/paris/i, 90_000);
      expect(answeredFrance).toBe(true);
      expect(session.capture()).toMatch(/haiku/i);

      // 4) WebSocket path: send a second prompt over the `/ws` stream-processor
      //    protocol (text-concat) and confirm Claude answers that one too.
      const sentWs = await sendPromptWsByTag(
        tag,
        "What is the capital of England? Answer in one short sentence.",
      );
      expect(sentWs.ok).toBe(true);
      const answeredEngland = await session.waitForText(/london/i, 90_000);
      expect(answeredEngland).toBe(true);

      // 5) On shutdown, the channel server removes its registry entry.
      await session.stop();
      expect(session.findServer()).toBeUndefined();
    } finally {
      await session.dispose();
    }
  }, 180_000);
});
