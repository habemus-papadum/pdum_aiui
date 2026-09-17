/**
 * setup.ts — how a page gets a session and a backend.
 *
 * One session factory (WebRTC through the paste → dev-key → server broker
 * chain) and one catalogue of BACKENDS the bench can switch between. Two
 * kinds live in the catalogue: DELEGATORS (client mode: the page receives
 * each delegation and answers it — in the browser, or over the relay on the
 * dev server) and the HOSTED mode (the vendor runs a Responses model with
 * our tools; that is session config, so switching to or from it restarts
 * the session).
 */

import {
  backendPrompt,
  browserKey,
  type Delegator,
  echoDelegator,
  type LiveConfig,
  type LivePromptSlots,
  LiveSession,
  type LiveTool,
  remoteDelegator,
  responsesDelegator,
  scriptedDelegator,
  standardBrokers,
  webRtcTransport,
} from "@habemus-papadum/aiui-live";

export type BackendId =
  | "scripted"
  | "echo"
  | "responses-browser"
  | "responses-server"
  | "claude"
  | "hosted";

export interface BackendChoice {
  id: BackendId;
  label: string;
  where: "browser" | "server" | "vendor";
  blurb: string;
}

export const BACKENDS: BackendChoice[] = [
  {
    id: "scripted",
    label: "scripted",
    where: "browser",
    blurb: "waits a fixed delay, then answers — the voice-side floor",
  },
  { id: "echo", label: "echo", where: "browser", blurb: "repeats what it heard, instantly" },
  {
    id: "responses-browser",
    label: "responses (browser key)",
    where: "browser",
    blurb:
      "a Responses model called from the page with your pasted or dev key; tools run in the page",
  },
  {
    id: "responses-server",
    label: "responses (server)",
    where: "server",
    blurb: "the same loop on the dev server with its key; page tools round-trip over the relay",
  },
  {
    id: "claude",
    label: "claude code (server)",
    where: "server",
    blurb:
      "Claude Code in this demo's source tree; speaks through say/note/steer; app tools over the relay",
  },
  {
    id: "hosted",
    label: "hosted responses (vendor)",
    where: "vendor",
    blurb:
      "delegation.type: responses — the vendor runs the model; the page only answers function calls",
  },
];

export interface BenchOptions {
  slots: LivePromptSlots;
  app?: string;
  tools?: () => LiveTool[];
  voice?: string;
  scriptedDelayMs?: () => number;
  onLog?: (line: string) => void;
}

export function makeDelegator(id: BackendId, options: BenchOptions): Delegator | undefined {
  switch (id) {
    case "scripted":
      return scriptedDelegator({
        delayMs: options.scriptedDelayMs?.() ?? 1500,
        reply: (req) => `Done. I heard: ${req.text || "nothing yet"}.`,
      });
    case "echo":
      return echoDelegator();
    case "responses-browser":
      return responsesDelegator({
        key: () => browserKey(),
        app: options.app,
        effort: "low",
        model: "gpt-5.4-mini",
      });
    case "responses-server":
      return remoteDelegator({ delegator: "responses", onLog: options.onLog });
    case "claude":
      return remoteDelegator({ delegator: "claude", onLog: options.onLog });
    case "hosted":
      return undefined;
  }
}

export function sessionConfigFor(id: BackendId, options: BenchOptions): LiveConfig {
  const base: LiveConfig = { instructions: options.slots, voice: options.voice };
  if (id !== "hosted") {
    return base;
  }
  return {
    ...base,
    delegation: {
      type: "responses",
      responses: {
        model: "gpt-5.6-terra",
        instructions: backendPrompt({ app: options.app }),
        reasoning: { effort: "low" },
      },
    },
  };
}

export function createBenchSession(id: BackendId, options: BenchOptions): LiveSession {
  const session = new LiveSession({
    transport: webRtcTransport({ broker: standardBrokers({ serverUrl: "/live/sessions" }) }),
    config: sessionConfigFor(id, options),
    delegator: makeDelegator(id, options),
    tools: options.tools?.() ?? [],
    idle: { closeAfterSeconds: 120 },
    progress: { afterMs: 9000 },
  });
  return session;
}
