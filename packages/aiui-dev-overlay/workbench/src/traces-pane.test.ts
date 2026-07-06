import { describe, expect, it } from "vitest";
import { inSession, traceRowParts } from "./traces-pane";

describe("inSession", () => {
  it("matches only the current session's traces; unlabeled traces are foreign", () => {
    expect(inSession({ id: "a", session: "workbench·1·120000" }, "workbench·1·120000")).toBe(true);
    expect(inSession({ id: "b", session: "workbench·2·090000" }, "workbench·1·120000")).toBe(false);
    expect(inSession({ id: "c" }, "workbench·1·120000")).toBe(false);
    // No known current session (older server) → nothing is filtered out.
    expect(inSession({ id: "d" }, undefined)).toBe(true);
  });
});

describe("traceRowParts", () => {
  it("badges rows from other sessions (and unlabeled ones) with their session", () => {
    const current = "workbench·1·120000";
    expect(traceRowParts({ id: "a", session: current }, current).badges).toEqual([]);
    expect(traceRowParts({ id: "b", session: "serve·9·080000" }, current).badges).toEqual([
      "serve·9·080000",
    ]);
    expect(traceRowParts({ id: "c" }, current).badges).toEqual(["unknown session"]);
  });
  it("labels a human completed trace with no badges", () => {
    const row = traceRowParts({
      id: "20260705225221997-j0ue8n",
      format: "intent-v1",
      status: "completed",
      startedAt: "2026-07-05T22:52:21.997Z",
      actor: "human",
    });
    expect(row.title).toContain("intent-v1");
    expect(row.badges).toEqual([]);
    expect(row.dim).toBe(false);
  });

  it("badges non-human actors — the agent-driven-UI-testing marker", () => {
    expect(traceRowParts({ id: "x", actor: "agent" }).badges).toEqual(["agent"]);
  });

  it("badges and dims abandoned traces", () => {
    const row = traceRowParts({ id: "x", status: "abandoned" });
    expect(row.badges).toEqual(["abandoned"]);
    expect(row.dim).toBe(true);
  });

  it("falls back to the trace id when there is no timestamp", () => {
    expect(traceRowParts({ id: "someid" }).title).toContain("someid");
  });

  it("titles the row with the turn summary when it has landed", () => {
    const row = traceRowParts({
      id: "x",
      format: "intent-v1",
      startedAt: "2026-07-06T18:52:21.997Z",
      summary: "rewrite the beet essay to say vite",
    });
    expect(row.title).toContain("rewrite the beet essay to say vite");
    // The gloss replaces the bare format in the title.
    expect(row.title).not.toContain("intent-v1");
  });
});

describe("cost in the row title", () => {
  it("appends the spend roll-up when the manifest carries one", () => {
    const { title } = traceRowParts({
      id: "t1",
      startedAt: "2026-07-06T18:52:01.000Z",
      summary: "rewrite the beet essay",
      costUsd: 0.0007,
    });
    expect(title).toContain("rewrite the beet essay · $0.0007");
    // No roll-up → no dangling separator.
    expect(traceRowParts({ id: "t2", format: "intent-v1" }).title.endsWith("intent-v1")).toBe(true);
  });
});
