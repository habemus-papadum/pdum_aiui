/**
 * glossary.ts — the tour's reference data, plain TypeScript: every wire
 * event with its direction and meaning, the engine's own options, the
 * backends as a comparison table, the measured numbers, and the vendor
 * pages each fact came from. Everything here is checked against
 * `packages/aiui-live/src/protocol.ts` / `session.ts` and the proposal
 * (`docs/proposals/oracle-live.md`); when they move, move this.
 */

import type { LedgerEntry } from "@habemus-papadum/aiui-live";

// ── vendor pages ─────────────────────────────────────────────────────────────

const OPENAI = "https://developers.openai.com/api/docs";
const CLAUDE = "https://platform.claude.com/docs/en/api/agent-sdk";

/** Append `.md` to any OpenAI docs URL to read the exact source text. */
export const LINKS = {
  live: `${OPENAI}/guides/live`,
  livePrompting: `${OPENAI}/guides/live-prompting`,
  liveConversations: `${OPENAI}/guides/live-conversations`,
  liveDelegation: `${OPENAI}/guides/live-delegation`,
  liveMigration: `${OPENAI}/guides/live-migration`,
  webrtc: `${OPENAI}/guides/voice-webrtc?api=live`,
  websockets: `${OPENAI}/guides/voice-websockets?api=live`,
  serverControls: `${OPENAI}/guides/voice-server-controls?api=live`,
  latencyCost: `${OPENAI}/guides/voice-latency-cost?api=live`,
  model: `${OPENAI}/models/gpt-live-1`,
  sdkOverview: `${CLAUDE}/overview`,
  sdkTypescript: `${CLAUDE}/typescript`,
  sdkSessions: `${CLAUDE}/sessions`,
  sdkCustomTools: `${CLAUDE}/custom-tools`,
  sdkPermissions: `${CLAUDE}/permissions`,
  sdkRepo: "https://github.com/anthropics/claude-agent-sdk-typescript",
  proposal: "https://github.com/habemus-papadum/pdum_aiui/blob/main/docs/proposals/oracle-live.md",
} as const;

// ── the wire vocabulary ──────────────────────────────────────────────────────

export interface WireEvent {
  type: string;
  /** `out` = we send it; `in` = the service sends it. */
  dir: "out" | "in";
  /** Which delegation mode it belongs to; `both` when either. */
  mode: "both" | "client" | "responses";
  /** Which transport carries it; `both` when either. */
  transport: "both" | "webrtc" | "websocket";
  meaning: string;
}

export const WIRE_EVENTS: WireEvent[] = [
  {
    type: "session.start",
    dir: "out",
    mode: "both",
    transport: "websocket",
    meaning:
      "The first WebSocket message: the whole session object. Over WebRTC the same object rides in the POST that exchanges the SDP offer, so nothing is sent on the data channel to start.",
  },
  {
    type: "session.started",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "The session is live. Carries the session record: id, expires_at (about two hours out), model. The engine flips to `live` here and starts the idle timer.",
  },
  {
    type: "session.input_audio.append",
    dir: "out",
    mode: "both",
    transport: "websocket",
    meaning:
      "Base64 PCM frames of the user's voice, continuously — silence included, so the timeline stays continuous. WebRTC sends the mic as a media track instead.",
  },
  {
    type: "session.input_transcript.delta",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "A FRAGMENT of what the user said, with start_ms/end_ms on the session timeline. No item ids, no turn boundaries; the engine regroups fragments by silence gap (800 ms) into utterances. Lags the audio by about 1.2 s.",
  },
  {
    type: "session.delegation.created",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "The voice model asked for help. Only an id, a target (client or responses) and offset_ms — no text. The engine opens a task and, in client mode, hands the user's words since the previous delegation to the delegator. Fires 0.5–0.8 s after the last word.",
  },
  {
    type: "session.commentary.append",
    dir: "out",
    mode: "both",
    transport: "both",
    meaning:
      "Something to SAY, paraphrased by the voice model. ≤ 500 tokens. delegation_id ties it to a ticket (null = session-wide). This is what `say` becomes.",
  },
  {
    type: "session.thinking.append",
    dir: "out",
    mode: "both",
    transport: "both",
    meaning:
      "A quiet fact the voice model may use later; not spoken on arrival unless the prompt asks it to narrate progress. ≤ 500 tokens. This is `note`.",
  },
  {
    type: "session.instructions.append",
    dir: "out",
    mode: "both",
    transport: "both",
    meaning:
      "A trusted directive — can interrupt speech; exact wording survives here (commentary gets rephrased). ≤ 500 tokens. This is `steer`. Instructions are append-only for the session's life.",
  },
  {
    type: "session.*.appended",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "The ack for one append: client_event_id names our event_id; start_ms/end_ms say when it was INJECTED (not spoken — speech began before the ack in our measurements). Settles the pending append in the engine.",
  },
  {
    type: "session.output_transcript.delta",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "A fragment of what the voice model is saying. The engine attributes the first fragment after an append to that append's task (`firstSpokenT`) — the wire itself never says which speech came from which append.",
  },
  {
    type: "session.output_audio.delta",
    dir: "in",
    mode: "both",
    transport: "websocket",
    meaning:
      "Base64 PCM of the reply. A CONTINUOUS stream, silence included — 'is it speaking' must come from transcript deltas or an energy gate. WebRTC delivers this as a media track instead.",
  },
  {
    type: "response.event",
    dir: "in",
    mode: "responses",
    transport: "both",
    meaning:
      "Hosted mode: one streaming event of the vendor-run Responses backend, nested under delegation_id — response.created, response.output_item.done (a function_call item is a tool request), response.completed (the text the voice model will speak), response.failed / response.incomplete.",
  },
  {
    type: "response.item.create",
    dir: "out",
    mode: "responses",
    transport: "both",
    meaning:
      "Hosted mode: hand the backend an item — a function_call_output answering its tool call, or a typed user message. Followed by response.create.",
  },
  {
    type: "response.create",
    dir: "out",
    mode: "responses",
    transport: "both",
    meaning:
      "Hosted mode: 'continue' — ask the backend to produce its next response after an item.",
  },
  {
    type: "session.update",
    dir: "out",
    mode: "responses",
    transport: "both",
    meaning:
      "The ONLY mutable config: `session.delegation.responses.*` (model, instructions, tools …). Everything else — model, voice, audio, store, delegation TYPE — is frozen at start. Echoed as session.updated.",
  },
  {
    type: "session.usage.updated",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "Billed seconds so far (cumulative) and context_window.usage_ratio, about every 15 s. Voice is $0.05 per minute, per second, silence included.",
  },
  {
    type: "session.input_audio.mute / unmute",
    dir: "out",
    mode: "both",
    transport: "both",
    meaning:
      "Server-side mute; the engine also gates the mic track locally. Echoed as session.input_audio.muted / unmuted. Muted time is still billed.",
  },
  {
    type: "session.close",
    dir: "out",
    mode: "both",
    transport: "both",
    meaning:
      "Ask the service to end the session. The engine sends it on close(), on the idle timeout, and waits for session.closed.",
  },
  {
    type: "session.closed",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "The end, with a reason (close_requested, expired, content, remote_hangup) and the final billed seconds. The engine keeps its own reason when it asked; the service's reason wins otherwise. The transcript is kept as the next session's re-seed.",
  },
  {
    type: "error",
    dir: "in",
    mode: "both",
    transport: "both",
    meaning:
      "Carries client_event_id when it answers one of our events (an oversize append: 'Context append text must not exceed 500 tokens.'; a stale id: 'Unknown client delegation.'). Without one it is a session-level error.",
  },
];

// ── the engine's own knobs (LiveSessionOptions) ──────────────────────────────

export interface EngineOption {
  key: string;
  defaultValue: string;
  meaning: string;
}

export const ENGINE_OPTIONS: EngineOption[] = [
  {
    key: "transport",
    defaultValue: "(required)",
    meaning: "How audio and events move: webRtcTransport in a browser, webSocketTransport in node.",
  },
  {
    key: "config",
    defaultValue: "{}",
    meaning:
      "What becomes the wire session object: model, instructions (a string or slots), voice, delegation, store, input, audio.",
  },
  {
    key: "delegator",
    defaultValue: "none",
    meaning:
      "Who answers client delegations. Swappable between tasks with setDelegator(). Without one a delegation fails and the failure line is spoken.",
  },
  {
    key: "tools",
    defaultValue: "[]",
    meaning:
      "Tools a backend may call. In hosted mode without explicit responses.tools they are registered as the backend's function tools; in client mode they travel with each DelegationRequest.",
  },
  {
    key: "progress",
    defaultValue: '{ afterMs: 9000, text: "Still working on it." }',
    meaning:
      "The engine speaks this on an open task that has appended nothing for afterMs — the voice model fills no silence on its own (measured). `false` disables it.",
  },
  {
    key: "idle",
    defaultValue: "{ closeAfterSeconds: 120, reseed: true }",
    meaning:
      "Silence is billed, so a session with no open task and no speech for this long closes itself; the next start() sends the last transcript as `input` (a developer note plus the recent turns, under a 6,000-token budget). `false` keeps it open.",
  },
  {
    key: "failureText",
    defaultValue: '"I couldn\'t finish that one."',
    meaning: "Spoken when a delegator throws or is missing. `false` says nothing.",
  },
  {
    key: "ackTimeoutMs",
    defaultValue: "10000",
    meaning: "How long an append waits for its …appended echo before resolving unacked.",
  },
  {
    key: "startTimeoutMs",
    defaultValue: "20000",
    meaning: "How long start() waits for session.started.",
  },
  {
    key: "gapMs",
    defaultValue: "800",
    meaning:
      "The silence that separates two transcript fragments into two utterances — a display and request-text choice, not a fact about the model.",
  },
  {
    key: "audioElement",
    defaultValue: "(created)",
    meaning: "WebRTC: the element that plays the reply track.",
  },
  {
    key: "now",
    defaultValue: "Date.now",
    meaning: "The clock (tests inject one).",
  },
];

// ── backends ─────────────────────────────────────────────────────────────────

export interface BackendFact {
  id: string;
  label: string;
  where: "browser" | "server" | "vendor";
  needs: string;
  path: string;
  tools: string;
  measured: string;
  useWhen: string;
}

export const BACKEND_FACTS: BackendFact[] = [
  {
    id: "scripted",
    label: "scripted",
    where: "browser",
    needs: "nothing",
    path: "in-process: the engine calls handle(req) directly",
    tools: "none",
    measured: "append → first spoken word +523 ms; the platform floor",
    useWhen: "measuring the voice side alone; unit tests; the wire page",
  },
  {
    id: "echo",
    label: "echo",
    where: "browser",
    needs: "nothing",
    path: "in-process",
    tools: "none",
    measured: "end of utterance → 'You said …' ≈ 1.0 s of platform overhead",
    useWhen: "checking what the request text looks like after transcript regrouping",
  },
  {
    id: "responses-browser",
    label: "responses (browser key)",
    where: "browser",
    needs: "an OpenAI key in the page (pasted or dev-injected)",
    path: "in-process: responsesDelegator POSTs /v1/responses from the page, store:false, one round per tool call",
    tools: "executed in the page directly",
    measured: "gpt-5.4-mini, low effort: 3 tool rounds in 4.1 s",
    useWhen: "a static app with a pasted key and no server; the watchable tool loop",
  },
  {
    id: "responses-server",
    label: "responses (server)",
    where: "server",
    needs: "OPENAI_API_KEY on the server; the relay route",
    path: "remoteDelegator → WS /live/delegate → the same responsesDelegator with the server's key",
    tools: "page tools round-trip as tool / tool_result relay frames (60 s timeout)",
    measured: "as above plus one relay hop",
    useWhen: "the key must never reach the browser; the vite plugin's default",
  },
  {
    id: "claude",
    label: "claude code (server)",
    where: "server",
    needs: "a logged-in Claude Code on the server machine; the Agent SDK; no API key",
    path: "remoteDelegator → WS /live/delegate → claudeDelegator → SDK query() → a `claude` child process (stream-json over stdio)",
    tools:
      "say/note/steer + app_call/app_list as an in-process MCP server; app_call round-trips to the page over the relay",
    measured:
      "read graph.ts and answered in 13.5–17.7 s, 6–7 turns, ≈ $0.31; first spoken line at +9 s was the engine's progress line",
    useWhen: "the question needs the code, a file, a shell, or minutes of work",
  },
  {
    id: "hosted",
    label: "hosted responses (vendor)",
    where: "vendor",
    needs: "only the session config (delegation.type: responses); billed to the same project key",
    path: "no delegator: the vendor runs the model and streams response.event; the page answers function calls",
    tools:
      "function calls arrive as response.output_item.done; the page replies response.item.create + response.create",
    measured:
      "gpt-5.6-terra low: delegation → function call 0.77 s; end of utterance → 'Done.' 2.9 s; 1112 input / 28 output tokens per delegation",
    useWhen: "zero infrastructure; tools that live in the page; the lowest latency for small tasks",
  },
];

// ── measured numbers (2026-09-15, exploration/live-probe + demos/live) ───────

export const MEASURED: Array<{ what: string; value: string }> = [
  {
    what: "socket open → session.started",
    value: "0.5–0.9 s (WebRTC in the session browser: 0.7–0.95 s)",
  },
  {
    what: "user stops → session.delegation.created",
    value: "0.49 / 0.72 / 0.80 / 0.54 s; offset_ms lands on the last word",
  },
  {
    what: "the voice model's own acknowledgement after delegating",
    value: "0.15–0.2 s ('Okay. Hang on.')",
  },
  { what: "commentary append → first spoken word", value: "0.52 / 0.67 / 0.58 s" },
  { what: "append → …appended ack", value: "≈ 0.7 s, after speech had already started" },
  {
    what: "thinking append (delegation_id null) → answered from it without delegating",
    value: "yes, 0.9 s",
  },
  {
    what: "client round trip with a 1.5 s tool",
    value: "2.55 s end of utterance → 'Done.' (≈ 1.0 s platform overhead)",
  },
  { what: "hosted mode, terra low: utterance → 'Done.'", value: "2.9 s" },
  { what: "session length", value: "expires_at ≈ 2 h; compaction at 90 % of 128 k context" },
  {
    what: "voice price",
    value: "$0.05 / min, per second, silence and mute included; +15 s at WebRTC creation",
  },
  { what: "input transcript lag behind audio", value: "≈ 1.2 s" },
  {
    what: "output audio",
    value: "continuous, silence included (31.2 s of audio for a 31 s session)",
  },
];

// ── explaining ledger rows ───────────────────────────────────────────────────

/** A one-line reading of a ledger entry for the 'what just happened' strip. */
export function explain(entry: LedgerEntry): string {
  const type = typeof entry.event?.type === "string" ? (entry.event.type as string) : undefined;
  if (type !== undefined) {
    if (type.endsWith(".appended")) {
      return "The service acknowledged an append: our event_id came back as client_event_id, with the injection time. Speech usually started before this arrived.";
    }
    const known = WIRE_EVENTS.find((candidate) => candidate.type === type);
    if (known !== undefined) {
      return known.meaning;
    }
    if (type.endsWith(".append")) {
      return "We sent an append. The engine now waits for its …appended echo (or an error naming this event_id).";
    }
  }
  switch (entry.kind) {
    case "delegation":
      return entry.dir === "local"
        ? "The engine handed the ticket to the delegator (or closed it): what follows are the delegator's log lines, then its appends."
        : "A delegation ticket was opened from the wire.";
    case "backend":
      return "A log line from the delegator — for the UI only, never spoken.";
    case "note":
      return entry.summary.startsWith("typed")
        ? "Typed input in hosted mode goes to the backend as a user message item plus response.create."
        : "An engine note (a local task for typed input, a delegator swap, the idle timer firing).";
    case "session":
      return entry.dir === "out"
        ? "We asked the transport to connect (the wire session object rides along) or to close."
        : "A session lifecycle event.";
    case "error":
      return "An error. With client_event_id it settles one append; otherwise the session itself reported a problem.";
    default:
      return "";
  }
}
