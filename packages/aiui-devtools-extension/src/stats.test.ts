import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes, formatMs } from "./stats.js";

describe("formatters", () => {
  it("formatBytes picks sane units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(12_345)).toBe("12.3 KB");
    expect(formatBytes(4_000_000)).toBe("4.0 MB");
  });

  it("formatMs scales precision with magnitude", () => {
    expect(formatMs(0.5)).toBe("0.50 ms");
    expect(formatMs(12.34)).toBe("12.3 ms");
    expect(formatMs(456.7)).toBe("457 ms");
    expect(formatMs(12_000)).toBe("12.0 s");
  });

  it("formatAgo buckets into s/m/h", () => {
    const now = 1_000_000_000;
    expect(formatAgo(now, now)).toBe("now");
    expect(formatAgo(now - 30_000, now)).toBe("30s ago");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});
