/**
 * The panel-side turn host: an intent-pipeline `Engine` plus the minimal
 * intent-v1 wire (browser-extension proposal §1 — the turn lives here, outside
 * every page). Reference lifecycle: the overlay's `multimodal/shell/wire.ts`;
 * server truth: `aiui-claude-channel/src/intent-v1.ts`. Text + selections
 * only for now — shots/audio arrive with their plan steps.
 *
 * Wire acts (the seam-analysis result, kept deliberately small):
 *  1. thread-open → connect `ws://127.0.0.1:<port>/ws`, hello `intent-v1`
 *     with meta {tab: active tab of the bound window, actor, intent: config}.
 *  2. every engine event → an `events` chunk (60 ms debounce batching).
 *  3. thread-close reason "send" → flush + bare `fin:true` frame → close;
 *     any other reason → close without fin (the server drops all state).
 *
 * The in-progress turn mirrors to `chrome.storage.session` (per window) so a
 * panel reload — including CRXJS full-reloads on wire edits — recovers it.
 */

import {
  DEFAULT_INTENT_CONFIG,
  type Engine,
  expandTier,
  type IntentEvent,
  type IntentPipelineConfig,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import {
  connectIntentSocket,
  type IntentSocket,
  isErrorMessage,
  type ServerMessage,
} from "@habemus-papadum/aiui-dev-overlay/protocol";

/**
 * The panel's effective config, declared on every hello as `meta.intent` so
 * traces record reality. `transcriber: "mock"` is deliberate (seam analysis
 * gotcha #1): the shipped default would open a per-thread upstream vendor
 * socket at thread-open — pointless for a text-only host.
 */
export function panelIntentConfig(): IntentPipelineConfig {
  return { ...DEFAULT_INTENT_CONFIG, ...expandTier("mock"), tier: "mock" };
}

const EVENTS_DEBOUNCE_MS = 60;

/** The events since the last thread-open — the persistence/replay unit. */
export function currentThreadEvents(events: readonly IntentEvent[]): IntentEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      return events.slice(i);
    }
  }
  return [];
}

export interface TurnHostDeps {
  engine: Engine;
  /** The bound channel port, or undefined (turn host stays inert). */
  port: () => number | undefined;
  /** The active tab of this panel's window, for the hello's context block. */
  activeTab: () => Promise<
    | { url?: string; title?: string; chromeTabId?: number; windowId?: number; tabIndex?: number }
    | undefined
  >;
  /** Surface a failure (status line / toast). */
  onError: (message: string) => void;
  /** The committed prompt, pushed by the server just before it enters the session. */
  onLoweredPrompt: (prompt: string) => void;
  /** Mirror sink for turn recovery (chrome.storage.session). */
  persist: (events: IntentEvent[], threadOpen: boolean) => void;
}

export interface TurnHost {
  /**
   * Upload a raw-binary attachment (a shot PNG) on the open thread socket —
   * the panel's mirror of the overlay wire's `uploadAttachment`: flush the
   * correlated event past the debounce first, so the server holds the `shot`
   * event when the bytes land (intent-v1 saves the blob by `id` and wires the
   * shot's path into it). No-op without an open thread: degraded exactly like
   * the overlay — the shot event still describes itself, just without pixels
   * server-side.
   */
  uploadAttachment(id: string, mime: string, bytes: Uint8Array): Promise<void>;
  /** Detach from the engine and close any open socket (a cancel). */
  dispose(): void;
}

/**
 * Attach the wire to an engine. Call once per engine instance; events flow
 * from `engine.onEvent`, exactly like the overlay modality's listener.
 */
export function attachTurnHost(deps: TurnHostDeps): TurnHost {
  let socket: Promise<IntentSocket> | undefined;
  let threadId: string | undefined;
  let outbox: IntentEvent[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const flush = async (fin = false): Promise<void> => {
    if (debounce !== undefined) {
      clearTimeout(debounce);
      debounce = undefined;
    }
    if (socket === undefined || threadId === undefined) {
      return;
    }
    const batch = outbox;
    outbox = [];
    try {
      const ws = await socket;
      if (batch.length > 0) {
        await ws.sendChunk(threadId, { kind: "events" }, { events: batch }, false);
      }
      if (fin) {
        await ws.send(threadId, undefined, true); // bare fin frame commits
        ws.close();
        socket = undefined;
        threadId = undefined;
      }
    } catch (err) {
      deps.onError(err instanceof Error ? err.message : String(err));
    }
  };

  const openThread = (): void => {
    const port = deps.port();
    if (port === undefined) {
      deps.onError("no channel bound — pick one in the Session pane");
      return;
    }
    threadId = crypto.randomUUID();
    // Assign the promise SYNCHRONOUSLY: the thread-open event that triggered
    // this must itself pass the `socket !== undefined` outbox gate below.
    socket = (async () => {
      const tab = await deps.activeTab();
      const meta = {
        ...(tab !== undefined ? { tab } : {}),
        actor: "human",
        intent: panelIntentConfig() as unknown as Record<string, unknown>,
      };
      return connectIntentSocket(`ws://127.0.0.1:${port}/ws`, "intent-v1", undefined, meta);
    })();
    socket
      .then((ws) => {
        ws.onServerMessage((msg: ServerMessage) => {
          if (isErrorMessage(msg)) {
            deps.onError(msg.message);
          } else if (msg.kind === "lowered-prompt" && typeof msg.prompt === "string") {
            deps.onLoweredPrompt(msg.prompt);
          }
        });
      })
      .catch((err) => {
        socket = undefined;
        threadId = undefined;
        deps.onError(`channel connect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  // Engine listeners are permanent (onEvent returns void); the engine and this
  // host share the panel document's lifetime, so there is nothing to detach.
  deps.engine.onEvent((event, engine) => {
    if (event.type === "thread-open") {
      openThread();
    }
    if (socket !== undefined) {
      outbox.push(event);
      debounce ??= setTimeout(() => {
        debounce = undefined;
        void flush();
      }, EVENTS_DEBOUNCE_MS);
    }
    if (event.type === "thread-close") {
      if (event.reason === "send") {
        void flush(true);
      } else {
        void socket?.then((ws) => ws.close()).catch(() => {});
        socket = undefined;
        threadId = undefined;
      }
    }
    deps.persist(currentThreadEvents(engine.events), engine.threadOpen);
  });

  return {
    async uploadAttachment(id, mime, bytes) {
      if (socket === undefined || threadId === undefined) {
        return; // degraded: no open thread — the event alone still travels
      }
      await flush(); // the correlated event first, past the debounce
      const tid = threadId;
      if (socket === undefined || tid === undefined) {
        return; // a cancel raced the capture's encode
      }
      try {
        const ws = await socket;
        const ack = await ws.sendAttachment(tid, { kind: "attachment", id, mime }, bytes, false);
        if (!ack.ok) {
          deps.onError(`attachment ${id} rejected: ${ack.error ?? "unknown error"}`);
        }
      } catch (err) {
        deps.onError(
          `attachment ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    dispose() {
      void socket?.then((ws) => ws.close()).catch(() => {});
      socket = undefined;
      threadId = undefined;
    },
  };
}

/** chrome.storage.session mirror (per window) — the turn-store, panel-grade. */
export function turnMirror(windowId: () => number | undefined): {
  persist: (events: IntentEvent[], threadOpen: boolean) => void;
  recover: () => Promise<{ events: IntentEvent[]; threadOpen: boolean } | undefined>;
} {
  const key = (): string => `aiui.turn.win${windowId() ?? 0}`;
  return {
    persist(events, threadOpen) {
      if (threadOpen && events.length > 0) {
        void chrome.storage.session.set({ [key()]: { events, threadOpen, savedAt: Date.now() } });
      } else {
        void chrome.storage.session.remove(key());
      }
    },
    async recover() {
      const got = (await chrome.storage.session.get(key()))[key()] as
        | { events: IntentEvent[]; threadOpen: boolean }
        | undefined;
      return got !== undefined && Array.isArray(got.events) && got.events.length > 0
        ? { events: got.events, threadOpen: got.threadOpen }
        : undefined;
    },
  };
}
