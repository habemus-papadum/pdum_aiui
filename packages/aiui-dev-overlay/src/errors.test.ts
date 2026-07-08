import { describe, expect, it } from "vitest";
import {
  addError,
  dismissError,
  ERROR_TOAST_CAP,
  formatErrorData,
  type OverlayError,
} from "./errors";

describe("addError", () => {
  it("appends a new error with id/count/timestamp", () => {
    const list = addError([], { message: "boom", source: "connection" }, { now: 42 });
    expect(list).toEqual([{ id: 1, count: 1, at: 42, message: "boom", source: "connection" }]);
  });

  it("keeps optional fields off entries that never provided them", () => {
    const [entry] = addError([], { message: "boom" });
    expect(entry).not.toHaveProperty("source");
    expect(entry).not.toHaveProperty("detail");
  });

  it("dedupes a repeat of the same source+message: bumps count, moves to newest", () => {
    let list = addError([], { message: "audio frame rejected", source: "channel" }, { now: 1 });
    list = addError(list, { message: "other", source: "channel" }, { now: 2 });
    // The repeat (as a dead thread rejecting every PCM frame would produce)…
    list = addError(list, { message: "audio frame rejected", source: "channel" }, { now: 3 });
    expect(list.map((e) => e.message)).toEqual(["other", "audio frame rejected"]);
    expect(list[1]).toMatchObject({ count: 2, at: 3 });
    // …never grows the list.
    expect(list).toHaveLength(2);
  });

  it("treats the same message under a different source as a different error", () => {
    let list = addError([], { message: "boom", source: "transcription" });
    list = addError(list, { message: "boom", source: "correction" });
    expect(list).toHaveLength(2);
  });

  it("refreshes the detail on a dedupe (the newest report wins)", () => {
    let list = addError([], { message: "boom", source: "x", detail: "first" });
    list = addError(list, { message: "boom", source: "x", detail: "second" });
    expect(list).toEqual([expect.objectContaining({ count: 2, detail: "second" })]);
  });

  it("caps the list, evicting the oldest", () => {
    let list: OverlayError[] = [];
    for (let i = 0; i < ERROR_TOAST_CAP + 2; i++) {
      list = addError(list, { message: `error ${i}` });
    }
    expect(list).toHaveLength(ERROR_TOAST_CAP);
    expect(list[0].message).toBe("error 2"); // 0 and 1 fell off
    expect(list.at(-1)?.message).toBe(`error ${ERROR_TOAST_CAP + 1}`);
  });

  it("never reuses the id of a shown entry (dismiss handles stay unambiguous)", () => {
    let list = addError([], { message: "a" });
    list = addError(list, { message: "b" });
    list = dismissError(list, 1);
    list = addError(list, { message: "c" });
    const ids = list.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("dismissError", () => {
  it("removes the entry by id and no-ops on unknown ids", () => {
    const list = addError(addError([], { message: "a" }), { message: "b" });
    const [a, b] = list;
    expect(dismissError(list, a.id).map((e) => e.message)).toEqual(["b"]);
    expect(dismissError(list, 999)).toEqual([a, b]);
  });
});

describe("addError structured data", () => {
  it("carries data onto the entry and refreshes it on a dedupe", () => {
    const first = addError([], { message: "m", source: "voice", data: { closeCode: 1006 } });
    expect(first[0].data).toEqual({ closeCode: 1006 });
    const second = addError(first, {
      message: "m",
      source: "voice",
      data: { closeCode: 1008, closeReason: "API key not valid." },
    });
    expect(second).toHaveLength(1);
    expect(second[0].count).toBe(2);
    expect(second[0].data).toEqual({ closeCode: 1008, closeReason: "API key not valid." });
  });

  it("a dedupe without data keeps the previous data (like detail)", () => {
    const first = addError([], { message: "m", data: { a: 1 } });
    const second = addError(first, { message: "m" });
    expect(second[0].data).toEqual({ a: 1 });
  });
});

describe("formatErrorData", () => {
  it("pretty-prints objects as 2-space JSON", () => {
    expect(formatErrorData({ error: { code: 403 } })).toBe(
      '{\n  "error": {\n    "code": 403\n  }\n}',
    );
  });

  it("pretty-prints a string that parses as JSON, passes other strings verbatim", () => {
    expect(formatErrorData('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatErrorData("Bad Gateway")).toBe("Bad Gateway");
  });

  it("stringifies the unserializable instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatErrorData(circular)).toBe("[object Object]");
    expect(formatErrorData(undefined)).toBe("undefined");
  });
});
