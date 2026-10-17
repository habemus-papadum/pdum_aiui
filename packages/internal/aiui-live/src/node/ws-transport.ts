/**
 * ws-transport.ts — the WebSocket transport (node): audio as base64 PCM
 * frames both ways, `session.start` as the first message. This is the
 * transport for headless probes and tests — a scripted "user" speaks
 * synthesized audio through it — and for any server-side voice front.
 *
 * `Authorization` is a header, which a browser WebSocket cannot set; the
 * browser transport is `webRtcTransport`.
 */

import { WebSocket } from "ws";
import { LIVE_WS_URL, type LiveEvent, type OutputAudioDeltaEvent } from "../protocol.ts";
import type { LiveTransport, TransportConnectOptions, TransportHandle } from "../types.ts";

/** A source of input audio: called with a `push` that takes raw PCM chunks
 * at the session's rate; must keep pushing (silence when quiet) so the
 * timeline stays continuous. */
export interface AudioSource {
  start(push: (pcm: Uint8Array) => void): void;
  stop(): void;
  setEnabled(on: boolean): void;
}

export interface WebSocketTransportOptions {
  key: string | (() => string | undefined);
  url?: string;
  input?: AudioSource;
  /** Every output audio delta, decoded. */
  onOutputAudio?: (pcm: Buffer, event: OutputAudioDeltaEvent) => void;
  /** Pass `session.output_audio.delta` events on to the session too. Default true. */
  forwardAudioEvents?: boolean;
}

export function webSocketTransport(options: WebSocketTransportOptions): LiveTransport {
  return {
    name: "websocket",
    connect(opts: TransportConnectOptions): Promise<TransportHandle> {
      const key = typeof options.key === "function" ? options.key() : options.key;
      if (key === undefined || key === "") {
        return Promise.reject(new Error("no key for the WebSocket transport"));
      }
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(options.url ?? LIVE_WS_URL, {
          headers: { Authorization: `Bearer ${key}` },
        });
        let opened = false;
        const handle: TransportHandle = {
          send(event) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(event));
            }
          },
          setMicEnabled(on) {
            options.input?.setEnabled(on);
          },
          close() {
            options.input?.stop();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close();
            }
          },
        };
        ws.on("open", () => {
          opened = true;
          ws.send(
            JSON.stringify({ type: "session.start", event_id: "start", session: opts.session }),
          );
          options.input?.start((pcm) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "session.input_audio.append",
                  audio: Buffer.from(pcm).toString("base64"),
                }),
              );
            }
          });
          resolve(handle);
        });
        ws.on("message", (data: Buffer) => {
          let event: LiveEvent;
          try {
            event = JSON.parse(data.toString()) as LiveEvent;
          } catch {
            opts.onEvent({ type: "live.client.unparseable", raw: data.toString().slice(0, 200) });
            return;
          }
          if (event.type === "session.output_audio.delta") {
            const audio = event as OutputAudioDeltaEvent;
            options.onOutputAudio?.(Buffer.from(audio.delta, "base64"), audio);
            if (options.forwardAudioEvents === false) {
              return;
            }
          }
          opts.onEvent(event);
        });
        ws.on("close", (code: number, reason: Buffer) => {
          options.input?.stop();
          if (!opened) {
            reject(new Error(`socket closed before open: ${code} ${reason.toString()}`));
            return;
          }
          opts.onClose(`socket closed ${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}`);
        });
        ws.on("error", (error: Error) => {
          if (!opened) {
            reject(error);
          } else {
            opts.onClose(`socket error: ${error.message}`);
          }
        });
      });
    },
  };
}
