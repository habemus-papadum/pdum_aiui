import { expect, it, vi } from "vitest";
import { claimSessionAudio } from "./session";
import type { AudioOutput, StreamInput } from "./types";

it("late connection cleanup cannot disable or detach its replacement", () => {
  const input: StreamInput = {
    id: "voice",
    label: "Voice",
    kind: "stream",
    stream: vi.fn(),
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
  const old = claimSessionAudio(input, output);
  const current = claimSessionAudio(input, output);
  current.input.setEnabled(true);
  vi.mocked(input.setEnabled).mockClear();
  vi.mocked(output.detach).mockClear();
  old.input.setEnabled(false);
  old.release();
  expect(input.setEnabled).not.toHaveBeenCalled();
  expect(output.detach).not.toHaveBeenCalled();
  current.release();
  expect(input.setEnabled).toHaveBeenCalledWith(false);
  expect(output.detach).toHaveBeenCalledOnce();
  expect(input.dispose).not.toHaveBeenCalled();
});
