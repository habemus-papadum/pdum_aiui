/** WebRTC borrows stable input/output endpoints from the application's AudioHub.
 * Device capture, routing, echo constraints, and playback belong to that hub.
 * Control events and media travel separately; their ordering is not guaranteed.
 */

import { type AudioOutput, claimSessionAudio, type StreamInput } from "@habemus-papadum/aiui-audio";
import type { SessionBroker } from "./brokers";
import type { LiveTransport, TransportConnectOptions, TransportHandle } from "./types";

export interface WebRtcTransportOptions {
  broker: SessionBroker;
  input: StreamInput;
  output: AudioOutput;
  createPeerConnection?: () => RTCPeerConnection;
  /** Cap on waiting for ICE gathering before sending the offer anyway. */
  iceGatherTimeoutMs?: number;
}

export function webRtcTransport(options: WebRtcTransportOptions): LiveTransport {
  return {
    name: "webrtc",
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

        pc.ontrack = (event) => {
          audio.output.attach(
            event.streams[0] ?? new MediaStream([event.track]),
            opts.audioElement,
          );
        };

        const data = pc.createDataChannel("oai-events");
        channel = data;
        const pending: string[] = [];
        data.onmessage = (event) => {
          try {
            opts.onEvent(JSON.parse(String(event.data)) as { type: string });
          } catch {
            opts.onEvent({ type: "live.client.unparseable", raw: String(event.data) });
          }
        };
        data.onopen = () => {
          for (const item of pending.splice(0)) {
            data.send(item);
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
        await waitForIceGathering(pc, options.iceGatherTimeoutMs ?? 1500);
        const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
        const answer = await options.broker.create(sdp, opts.session);
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        audio.input.setEnabled(true);
        return {
          send(event) {
            const encoded = JSON.stringify(event);
            if (data.readyState === "open") {
              data.send(encoded);
            } else {
              pending.push(encoded);
            }
          },
          setMicEnabled(on) {
            audio.input.setEnabled(on);
          },
          close: teardown,
          sessionId: answer.sessionId,
          micStream: mic,
        };
      } catch (error) {
        teardown();
        throw error;
      }
    },
  };
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}
