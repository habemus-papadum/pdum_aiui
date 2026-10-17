/** WebRTC borrows stable input/output endpoints from the application's AudioHub.
 * Device capture, routing, echo constraints, and playback belong to that hub.
 * Control events and media travel separately; their ordering is not guaranteed.
 */

import { type AudioOutput, claimSessionAudio, type StreamInput } from "@habemus-papadum/aiui-audio";
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
  /** Registered endpoints from the application's shared AudioHub. */
  input: StreamInput;
  output: AudioOutput;
  /** Injected for tests; defaults to the real RTCPeerConnection. */
  createPeerConnection?: () => RTCPeerConnection;
}

export function webRtcTransport(options: WebRtcTransportOptions): OracleTransport {
  return {
    name: "webrtc",
    capabilities: WEBRTC_CAPABILITIES,
    async connect(opts: TransportConnectOptions): Promise<TransportHandle> {
      const pc = (options.createPeerConnection ?? (() => new RTCPeerConnection()))();

      const audio = claimSessionAudio(options.input, options.output);
      let channel: RTCDataChannel | undefined;
      const teardown = () => {
        if (channel) {
          channel.onclose = null;
          channel.onmessage = null;
          channel.onopen = null;
        }
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
        audio.release();
      };
      try {
        const mic = audio.input.stream();
        const micTrack = mic.getAudioTracks()[0];
        if (micTrack === undefined) {
          pc.close();
          throw new Error("Audio input endpoint returned no track");
        }
        pc.addTrack(micTrack, mic);

        // Reply playback: autoplay is expected to succeed because connecting is
        // itself gesture-driven (the start button) — but a blocked `play()` is
        // surfaced, never swallowed (the SpeechPlayer onBlocked lesson).
        pc.ontrack = (event) => {
          audio.output.attach(
            event.streams[0] ?? new MediaStream([event.track]),
            opts.audioElement,
          );
        };

        const data = pc.createDataChannel("oai-events");
        channel = data;
        data.onmessage = (event) => {
          try {
            opts.onEvent(JSON.parse(String(event.data)) as Record<string, unknown>);
          } catch {
            opts.onEvent({ type: "oracle.client.unparseable", raw: String(event.data) });
          }
        };
        data.onclose = () => opts.onClose("data channel closed");
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
        data.onopen = () => {
          for (const item of pending.splice(0)) {
            data.send(item);
          }
        };

        const send = (event: Record<string, unknown>): void => {
          const encoded = JSON.stringify(event);
          if (data.readyState === "open") {
            data.send(encoded);
          } else {
            pending.push(encoded);
          }
        };

        audio.input.setEnabled(true);
        return {
          send,
          setMicEnabled(on) {
            audio.input.setEnabled(on);
          },
          interrupt() {
            send({ type: "response.cancel" });
            send({ type: "output_audio_buffer.clear" });
          },
          micStream: mic,
          applyAudioConstraints: (constraints) => options.input.applyConstraints(constraints),
          audioSettings: () => {
            try {
              return options.input.settings() as Record<string, unknown>;
            } catch {
              return undefined;
            }
          },
          ...(callId !== undefined && callId !== "" ? { callId } : {}),
          close: teardown,
        };
      } catch (error) {
        teardown();
        throw error;
      }
    },
  };
}
