/**
 * webrtc.ts — the WebRTC transport (the browser default, owner decision
 * 2026-07-26): mic as a sender track, reply audio as a remote track on an
 * `<audio>` element, events on the `oai-events` data channel.
 *
 * The three seams, WebRTC-flavored:
 *  - input audio: the live mic track. Gating = `track.enabled = false`, never
 *    teardown (the runtime's lesson: a disabled track keeps the timeline
 *    continuous). No PCM injection — the live mic is THE input (decision).
 *  - output audio: track only. `response.output_audio.delta` is NOT delivered
 *    on this transport (community-found, SDK-corroborated) — hence
 *    `replyAudioData: false`; a level meter taps the element/stream, not data.
 *  - interrupt: server-managed. The vendor auto-truncates on barge-in; a
 *    manual stop is `response.cancel` + `output_audio_buffer.clear` (the
 *    official SDK's exact pair).
 *
 * Caveat carried from research: audio and control ride SEPARATE channels with
 * no mutual ordering — nothing here may assume a control event is ordered
 * against an audio position.
 */

import { OPENAI_BASE_URL } from "./keys";
import type {
  OracleTransport,
  TransportCapabilities,
  TransportConnectOptions,
  TransportHandle,
} from "./types";

export const WEBRTC_CAPABILITIES: TransportCapabilities = {
  replyAudioData: false,
  serverBargeIn: true,
  injectAudio: false,
  sideband: true,
};

export interface WebRtcTransportOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injected for tests; defaults to the real RTCPeerConnection. */
  createPeerConnection?: () => RTCPeerConnection;
}

export function webRtcTransport(options: WebRtcTransportOptions = {}): OracleTransport {
  return {
    name: "webrtc",
    capabilities: WEBRTC_CAPABILITIES,
    async connect(opts: TransportConnectOptions): Promise<TransportHandle> {
      const getUserMedia = options.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
      const pc = (options.createPeerConnection ?? (() => new RTCPeerConnection()))();

      const mic = await getUserMedia({ audio: true });
      const micTrack = mic.getAudioTracks()[0];
      if (micTrack === undefined) {
        pc.close();
        throw new Error("no audio track — mic permission granted but empty stream");
      }
      pc.addTrack(micTrack, mic);

      // Reply playback: autoplay is expected to succeed because connecting is
      // itself gesture-driven (the start button) — but a blocked `play()` is
      // surfaced, never swallowed (the SpeechPlayer onBlocked lesson).
      const audio = opts.audioElement ?? document.createElement("audio");
      audio.autoplay = true;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        audio.play().catch(() => opts.onPlaybackBlocked?.());
      };

      const channel = pc.createDataChannel("oai-events");
      channel.onmessage = (event) => {
        try {
          opts.onEvent(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch {
          opts.onEvent({ type: "oracle.client.unparseable", raw: String(event.data) });
        }
      };
      channel.onclose = () => opts.onClose("data channel closed");
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          opts.onClose(`peer connection ${pc.connectionState}`);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(`${options.baseUrl ?? OPENAI_BASE_URL}/v1/realtime/calls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.credential.ek}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp ?? "",
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        pc.close();
        for (const track of mic.getTracks()) {
          track.stop();
        }
        throw new Error(`realtime call setup failed (${response.status}): ${body.slice(0, 300)}`);
      }
      // The `Location` header carries the call id — CORS-exposed, and the
      // sideband hook: a server with its own key can join this exact call.
      const location = response.headers.get("Location") ?? "";
      const callId = location.split("/").filter(Boolean).pop();
      const answer = await response.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });

      // The engine sends its opening session.update the moment the channel
      // opens; queue sends until then rather than racing the SCTP handshake.
      const pending: string[] = [];
      channel.onopen = () => {
        for (const item of pending.splice(0)) {
          channel.send(item);
        }
      };

      const send = (event: Record<string, unknown>): void => {
        const encoded = JSON.stringify(event);
        if (channel.readyState === "open") {
          channel.send(encoded);
        } else {
          pending.push(encoded);
        }
      };

      return {
        send,
        setMicEnabled(on) {
          micTrack.enabled = on;
        },
        interrupt() {
          send({ type: "response.cancel" });
          send({ type: "output_audio_buffer.clear" });
        },
        micStream: mic,
        ...(callId !== undefined && callId !== "" ? { callId } : {}),
        close() {
          channel.onclose = null;
          pc.onconnectionstatechange = null;
          pc.close();
          for (const track of mic.getTracks()) {
            track.stop();
          }
          audio.srcObject = null;
        },
      };
    },
  };
}
