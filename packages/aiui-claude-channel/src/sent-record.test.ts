import { describe, expect, it } from "vitest";
import { createSentRecord } from "./sent-record";

describe("sent record", () => {
  it("keeps the last pushes, oldest first, with their kind and meta", () => {
    let n = 0;
    const record = createSentRecord(2, () => new Date(1700000000000 + n++ * 1000));
    record.push("startup", "aiui channel connected");
    record.push("prompt", "do the thing", { "attachment-1": "/tmp/shot.png" });
    record.push("channel-stale", "stale");
    expect(record.list()).toEqual([
      {
        at: "2023-11-14T22:13:21.000Z",
        kind: "prompt",
        text: "do the thing",
        meta: { "attachment-1": "/tmp/shot.png" },
      },
      { at: "2023-11-14T22:13:22.000Z", kind: "channel-stale", text: "stale" },
    ]);
  });
});
