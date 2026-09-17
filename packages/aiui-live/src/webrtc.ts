/**
 * webrtc.ts — the browser transport: mic as a sender track, reply audio as
 * a remote track on an `<audio>` element, events on the `oai-events` data
 * channel. The session is CREATED by the SDP exchange (a broker's POST) —
 * nothing is sent on the channel until `session.started` arrives.
 *
 * Vendor sequence (voice-webrtc guide): tracks → data channel and listeners
 * BEFORE the offer → local description → wait for ICE gathering → exchange
 * → remote description → wait for `session.started`.
 *
 * Carried from the oracle (found live 2026-07-30): explicit echo-safe mic
 * constraints. Full duplex makes this MORE important, not less — the model
 * listens while it speaks.
 */

import type { SessionBroker } from "./brokers";
import type { LiveTransport, TransportConnectOptions, TransportHandle } from "./types";

export const ECHO_SAFE_AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface WebRtcTransportOptions {
  broker: SessionBroker;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection?: () => RTCPeerConnection;
  audio?: MediaTrackConstraints;
  /** Cap on waiting for ICE gathering before sending the offer anyway. */
  iceGatherTimeoutMs?: number;
}

export function webRtcTransport(options: WebRtcTransportOptions): LiveTransport {
  return {
    name: "webrtc",
    async connect(opts: TransportConnectOptions): Promise<TransportHandle> {
      const getUserMedia = options.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
      const pc = (options.createPeerConnection ?? (() => new RTCPeerConnection()))();
      const mic = await getUserMedia({ audio: { ...ECHO_SAFE_AUDIO, ...options.audio } });
      const micTrack = mic.getAudioTracks()[0];
      if (micTrack === undefined) {
        pc.close();
        throw new Error("no audio track — mic permission granted but empty stream");
      }
      pc.addTrack(micTrack, mic);

      const audio = opts.audioElement ?? document.createElement("audio");
      audio.autoplay = true;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        audio.play().catch(() => opts.onPlaybackBlocked?.());
      };

      const channel = pc.createDataChannel("oai-events");
      const pending: string[] = [];
      channel.onmessage = (event) => {
        try {
          opts.onEvent(JSON.parse(String(event.data)) as { type: string });
        } catch {
          opts.onEvent({ type: "live.client.unparseable", raw: String(event.data) });
        }
      };
      channel.onopen = () => {
        for (const item of pending.splice(0)) {
          channel.send(item);
        }
      };
      channel.onclose = () => opts.onClose("data channel closed");
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          opts.onClose(`peer connection ${pc.connectionState}`);
        }
      };

      const teardown = () => {
        channel.onclose = null;
        pc.onconnectionstatechange = null;
        pc.close();
        for (const track of mic.getTracks()) {
          track.stop();
        }
        audio.srcObject = null;
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc, options.iceGatherTimeoutMs ?? 1500);
        const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
        const answer = await options.broker.create(sdp, opts.session);
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        return {
          send(event) {
            const encoded = JSON.stringify(event);
            if (channel.readyState === "open") {
              channel.send(encoded);
            } else {
              pending.push(encoded);
            }
          },
          setMicEnabled(on) {
            micTrack.enabled = on;
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
