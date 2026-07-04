import { afterEach, describe, expect, it, vi } from "vitest";

// Intercept the perl spawn so we can assert on it without touching a real tty.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: () => {} })),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { nudgeChannelAck } from "./enter-nudge";

const supported = process.platform === "darwin" || process.platform === "linux";
const expectedTiocsti = process.platform === "darwin" ? "2147578994" : "21522";

describe("nudgeChannelAck", () => {
  afterEach(() => {
    spawnMock.mockClear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.runIf(supported)("injects a CR via perl + the platform TIOCSTI, on unref'd timers", () => {
    vi.useFakeTimers();
    nudgeChannelAck([10, 20]);
    // Nothing fires synchronously.
    expect(spawnMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(25);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("perl");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain("/dev/tty"); // opens the controlling terminal
    expect(args[1]).toContain("ioctl");
    expect(args[2]).toBe(expectedTiocsti); // the request number the caller passes to perl
    expect(opts).toEqual({ stdio: "ignore" });
  });

  it("does nothing when AIUI_NO_ENTER_NUDGE is set", () => {
    vi.useFakeTimers();
    vi.stubEnv("AIUI_NO_ENTER_NUDGE", "1");
    nudgeChannelAck([10]);
    vi.advanceTimersByTime(20);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
