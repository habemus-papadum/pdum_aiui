import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  isProcessAlive,
  livenessVerdicts,
  parseEtimeSeconds,
  parseProcStatStartTicks,
  parsePsStartTimes,
  processStartTimes,
} from "./liveness.ts";

/** A pid that certainly refers to no live process: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return child.pid ?? -1;
}

describe("isProcessAlive", () => {
  it("is true for this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
  it("is false for an exited process and for nonsense pids", () => {
    expect(isProcessAlive(deadPid())).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe("parseEtimeSeconds", () => {
  it("parses mm:ss, hh:mm:ss, and dd-hh:mm:ss", () => {
    expect(parseEtimeSeconds("01:23")).toBe(83);
    expect(parseEtimeSeconds("1:01:23")).toBe(3683);
    expect(parseEtimeSeconds("2-01:01:23")).toBe(2 * 86400 + 3683);
    expect(parseEtimeSeconds("00:00")).toBe(0);
  });
  it("rejects garbage", () => {
    expect(parseEtimeSeconds("")).toBeUndefined();
    expect(parseEtimeSeconds("abc")).toBeUndefined();
    expect(parseEtimeSeconds("5")).toBeUndefined();
  });
});

describe("parsePsStartTimes", () => {
  it("maps pid → start ms from batched ps output", () => {
    const now = 1_000_000_000;
    const map = parsePsStartTimes("  123  01:40\n  456  1-00:00:10\n garbage\n", now);
    expect(map.get(123)).toBe(now - 100 * 1000);
    expect(map.get(456)).toBe(now - (86400 + 10) * 1000);
    expect(map.size).toBe(2);
  });
});

describe("parseProcStatStartTicks", () => {
  it("reads field 22 past a comm with spaces and parens", () => {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt
    // cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
    const tail = "S 1 1 1 0 -1 4194560 500 0 0 0 10 20 0 0 20 0 1 0 777777 0 0";
    expect(parseProcStatStartTicks(`42 (a (weird) name) ${tail}`)).toBe(777777);
  });
  it("returns undefined for malformed content", () => {
    expect(parseProcStatStartTicks("no close paren")).toBeUndefined();
  });
});

describe("processStartTimes (real platform)", () => {
  it("reports this process as started before now", () => {
    const now = Date.now();
    const map = processStartTimes([process.pid], now);
    const start = map.get(process.pid);
    expect(start).toBeDefined();
    expect(start ?? 0).toBeLessThanOrEqual(now + 1000);
    expect(start ?? 0).toBeGreaterThan(now - 6 * 3600 * 1000); // sanity: < 6h old
  });
});

describe("livenessVerdicts", () => {
  it("judges a live entry live and a dead one dead (real probes)", () => {
    const verdicts = livenessVerdicts([
      { pid: process.pid, startedAt: new Date().toISOString() },
      { pid: deadPid(), startedAt: new Date().toISOString() },
    ]);
    expect(verdicts.get(process.pid)).toBe("live");
    expect([...verdicts.values()].filter((v) => v === "dead")).toHaveLength(1);
  });

  it("judges recycled when the OS start postdates the registration (real start time)", () => {
    // This process is alive but started long after 1970 — exactly what a
    // recycled pid looks like against an ancient entry.
    const verdicts = livenessVerdicts([
      { pid: process.pid, startedAt: "1970-01-02T00:00:00.000Z" },
    ]);
    expect(verdicts.get(process.pid)).toBe("recycled");
  });

  it("fails open when the start time is unavailable", () => {
    const verdicts = livenessVerdicts(
      [{ pid: process.pid, startedAt: "1970-01-02T00:00:00.000Z" }],
      {
        getStartTimes: () => new Map(),
      },
    );
    expect(verdicts.get(process.pid)).toBe("live");
  });

  it("respects the slack window", () => {
    const registered = Date.parse("2026-07-20T00:00:00.000Z");
    const within = livenessVerdicts([{ pid: process.pid, startedAt: "2026-07-20T00:00:00.000Z" }], {
      getStartTimes: () => new Map([[process.pid, registered + 4000]]),
    });
    expect(within.get(process.pid)).toBe("live");
    const beyond = livenessVerdicts([{ pid: process.pid, startedAt: "2026-07-20T00:00:00.000Z" }], {
      getStartTimes: () => new Map([[process.pid, registered + 6000]]),
    });
    expect(beyond.get(process.pid)).toBe("recycled");
  });
});
