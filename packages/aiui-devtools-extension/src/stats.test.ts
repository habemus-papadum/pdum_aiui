import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes, formatMs, percentile, summarizeRtt } from "./stats.js";

describe("percentile (nearest rank)", () => {
  it("handles empty, single, and typical arrays", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 50)).toBe(7);
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
  });
});

describe("summarizeRtt", () => {
  it("is null with no samples", () => {
    expect(summarizeRtt([])).toBeNull();
  });

  it("computes count/avg/p50/p95 from unsorted input", () => {
    const summary = summarizeRtt([30, 10, 20]);
    expect(summary).toEqual({ count: 3, avgMs: 20, p50Ms: 20, p95Ms: 30 });
  });
});

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
