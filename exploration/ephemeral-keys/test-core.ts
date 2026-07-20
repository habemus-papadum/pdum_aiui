/**
 * Turn a {@link MintedKey} into a real connection against the vendor endpoint,
 * and classify the first thing that happens. Shared by the smoke test and the
 * expiry test in `test-keys.ts`. Connection shapes are grounded in `RESEARCH.md`
 * and mirror the channel's own handshakes.
 */

import { GEMINI_MODEL } from "./mint-core.ts";
import type { MintedKey } from "./spec.ts";
import { probeWs, type WsProbeOptions, type WsProbeResult } from "./util.ts";

const OPENAI_LINTER_WS = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
const OPENAI_TRANSCRIBE_WS = "wss://api.openai.com/v1/realtime?intent=transcription";
const GEMINI_CONSTRAINED_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const ELEVENLABS_WS = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/** Build the exact WS connection (URL + auth placement + opening frame) for a key. */
export function buildConnection(key: MintedKey, timeoutMs = 12_000): WsProbeOptions {
  switch (key.vendor) {
    case "openai": {
      const url = key.surface === "realtime-linter" ? OPENAI_LINTER_WS : OPENAI_TRANSCRIBE_WS;
      // ek_… rides the Authorization header, exactly like a real key.
      return { url, headers: { authorization: `Bearer ${key.token}` }, timeoutMs };
    }
    case "gemini": {
      // Ephemeral token → the *Constrained* v1alpha endpoint, token on ?access_token=.
      const url = `${GEMINI_CONSTRAINED_WS}?access_token=${encodeURIComponent(key.token)}`;
      // A setup frame is still required even though the model is locked in the token.
      return { url, onOpenSend: [{ setup: { model: `models/${GEMINI_MODEL}` } }], timeoutMs };
    }
    case "elevenlabs": {
      // Single-use token replaces the xi-api-key header, on the ?token= query param.
      const q = new URLSearchParams({
        model_id: key.scopedModels[0] ?? "scribe_v2_realtime",
        token: key.token,
        audio_format: "pcm_24000",
        include_timestamps: "true",
      });
      return { url: `${ELEVENLABS_WS}?${q.toString()}`, timeoutMs };
    }
  }
}

export interface Classification {
  ok: boolean;
  /** Short human summary of what the first frame/outcome told us. */
  reason: string;
}

/** Read `message_type` / event `type` out of a parsed first frame. */
function frameType(msg: unknown): string | undefined {
  if (msg && typeof msg === "object") {
    const o = msg as Record<string, unknown>;
    if (typeof o.type === "string") return o.type; // OpenAI realtime events
    if (typeof o.message_type === "string") return o.message_type; // ElevenLabs
    if ("setupComplete" in o) return "setupComplete"; // Gemini
    if ("error" in o) return "error";
  }
  return undefined;
}

/** Does the probe outcome mean "the token was accepted and the session is live"? */
export function classifySuccess(key: MintedKey, p: WsProbeResult): Classification {
  if (p.outcome !== "message") {
    return { ok: false, reason: describeFailure(p) };
  }
  const t = frameType(p.firstMessage);
  switch (key.vendor) {
    case "openai": {
      // A live session announces itself; an accepted token never opens with `error`.
      if (t && (t.startsWith("session.") || t.startsWith("transcription_session."))) {
        return { ok: true, reason: `first event: ${t}` };
      }
      if (t === "error")
        return { ok: false, reason: `error frame: ${p.rawMessage?.slice(0, 160)}` };
      return { ok: false, reason: `unexpected first event: ${t ?? p.rawMessage?.slice(0, 120)}` };
    }
    case "gemini": {
      if (t === "setupComplete") return { ok: true, reason: "setupComplete" };
      return { ok: false, reason: `unexpected first frame: ${p.rawMessage?.slice(0, 160)}` };
    }
    case "elevenlabs": {
      if (t === "session_started") return { ok: true, reason: "session_started" };
      if (t === "auth_error")
        return { ok: false, reason: `auth_error: ${p.rawMessage?.slice(0, 160)}` };
      return { ok: false, reason: `unexpected first frame: ${t ?? p.rawMessage?.slice(0, 120)}` };
    }
  }
}

/** Human-readable summary of a non-message probe outcome (for both success + expiry paths). */
export function describeFailure(p: WsProbeResult): string {
  switch (p.outcome) {
    case "http-error":
      return `HTTP ${p.httpStatus} upgrade rejected${p.httpBody ? ` — ${p.httpBody.slice(0, 160)}` : ""}`;
    case "closed":
      return `closed code=${p.closeCode}${p.closeReason ? ` reason=${JSON.stringify(p.closeReason)}` : ""}`;
    case "error":
      return `socket error: ${p.errorMessage}`;
    case "timeout":
      return `timed out after ${p.elapsedMs}ms with no frame`;
    case "message":
      return `frame: ${p.rawMessage?.slice(0, 160)}`;
  }
}

/** Connect once with a key and classify whether the credential works. */
export async function smokeTest(
  key: MintedKey,
): Promise<{ probe: WsProbeResult; verdict: Classification }> {
  const probe = await probeWs(buildConnection(key));
  return { probe, verdict: classifySuccess(key, probe) };
}
