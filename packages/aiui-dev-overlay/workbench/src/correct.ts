/**
 * The lab's real (`openai`) corrector — kept here, not in the overlay.
 *
 * The `Corrector` seam, the `mock`, and the `SYSTEM_PROMPT` now live in the
 * overlay (imported by `main.ts`); the shipping modality's `openai` correction
 * runs channel-side (stream a patchless correction, merge the echoed patch).
 * The lab has no channel, so it keeps this dev-proxy implementation against the
 * same interface: POST {model, messages} to the vite dev server's `/api/chat`,
 * key server-side. This is the interesting case — the model may rightly touch
 * text outside the selection ("make it plural everywhere"), which is the whole
 * reason corrections are patches and not string replaces.
 */
import { type Corrector, SYSTEM_PROMPT } from "@habemus-papadum/aiui-dev-overlay";

/** LLM-backed corrector via the dev server's /api/chat proxy (lab only). */
export function openaiCorrector(model: () => string): Corrector {
  return {
    name: "openai",
    async diff({ docLines, selected, instruction }) {
      const started = performance.now();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `TRANSCRIPT:\n${docLines.join("\n")}\n\nSELECTED: ${JSON.stringify(
                selected,
              )}\n\nINSTRUCTION: ${JSON.stringify(instruction)}`,
            },
          ],
        }),
      });
      const payload = (await res.json()) as { content?: string; error?: string };
      if (!res.ok || payload.error || !payload.content) {
        throw new Error(payload.error ?? `correction failed (${res.status})`);
      }
      if (!payload.content.includes("*** Begin Patch")) {
        throw new Error(`model did not return a patch: ${payload.content.slice(0, 120)}`);
      }
      return { patch: payload.content, model: model(), latencyMs: performance.now() - started };
    },
  };
}
