import type { AudioOutput, StreamInput } from "@habemus-papadum/aiui-audio";
import { expect, it, vi } from "vitest";
import type { TransportConnectOptions } from "./types";
import { webRtcTransport } from "./webrtc";

function fixture(fail = false) {
  const track = { stop: vi.fn() };
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const input: StreamInput = {
    id: "voice",
    label: "Voice",
    kind: "stream",
    stream: () => stream,
    settings: vi.fn(),
    applyConstraints: vi.fn(),
    setEnabled: vi.fn(),
    dispose: vi.fn(),
  };
  const output: AudioOutput = {
    id: "voice",
    label: "Voice",
    attach: vi.fn(),
    detach: vi.fn(),
    dispose: vi.fn(),
  };
  const pc = {
    addTrack: vi.fn(),
    createDataChannel: () => ({ readyState: "open", send: vi.fn() }),
    createOffer: vi.fn(async () => {
      if (fail) throw new Error("SDP failed");
      return { sdp: "offer" };
    }),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
    iceGatheringState: "complete",
  };
  const transport = webRtcTransport({
    input,
    output,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
    broker: { describe: () => "fixture", create: vi.fn(async () => ({ sdp: "answer" })) },
  });
  const options = {
    session: {},
    onEvent: vi.fn(),
    onClose: vi.fn(),
    onPlaybackBlocked: vi.fn(),
  } as unknown as TransportConnectOptions;
  return { transport, options, input, output, pc, track };
}
it("borrows a hub track and releases the endpoint without stopping capture", async () => {
  const f = fixture();
  const handle = await f.transport.connect(f.options);
  expect(f.input.setEnabled).toHaveBeenLastCalledWith(true);
  handle.setMicEnabled(false);
  expect(f.input.setEnabled).toHaveBeenLastCalledWith(false);
  handle.close();
  expect(f.pc.close).toHaveBeenCalled();
  expect(f.output.detach).toHaveBeenCalled();
  expect(f.track.stop).not.toHaveBeenCalled();
  expect(f.input.dispose).not.toHaveBeenCalled();
});
it("cleans up a failed offer while retaining hub ownership", async () => {
  const f = fixture(true);
  await expect(f.transport.connect(f.options)).rejects.toThrow("SDP failed");
  expect(f.pc.close).toHaveBeenCalled();
  expect(f.input.setEnabled).toHaveBeenLastCalledWith(false);
  expect(f.track.stop).not.toHaveBeenCalled();
});
