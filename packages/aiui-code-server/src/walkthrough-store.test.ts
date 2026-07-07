import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Walkthrough } from "@habemus-papadum/aiui-code-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWalkthroughStore } from "./walkthrough-store";

const validWalkthrough = (over: Partial<Walkthrough> = {}): Walkthrough => ({
  id: "",
  title: "Tour One",
  steps: [
    {
      file: "pkg/a.py",
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
      prose: "Here is where it starts.",
    },
  ],
  ...over,
});

describe("createWalkthroughStore", () => {
  let dir = "";

  beforeEach(async () => {
    // Point at a not-yet-created subdir to prove save() creates it.
    dir = join(await mkdtemp(join(tmpdir(), "aiui-wt-")), "walkthroughs");
  });

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips save → list → get with a generated, deterministic id", async () => {
    const store = createWalkthroughStore({
      dir,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
      newId: () => "abc123",
    });

    const { id } = await store.save(validWalkthrough({ createdBy: "agent" }));
    expect(id).toBe("tour-one-abc123");

    const list = await store.list();
    expect(list).toEqual([
      {
        id: "tour-one-abc123",
        title: "Tour One",
        stepCount: 1,
        createdBy: "agent",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    ]);

    const got = await store.get(id);
    expect(got?.id).toBe("tour-one-abc123");
    expect(got?.createdAt).toBe("2026-07-06T00:00:00.000Z");
    expect(got?.steps).toHaveLength(1);
  });

  it("keeps a caller-provided id and stamps createdAt when missing", async () => {
    const store = createWalkthroughStore({
      dir,
      now: () => new Date("2026-07-06T12:00:00.000Z"),
      newId: () => "zzz",
    });
    const { id } = await store.save(validWalkthrough({ id: "my-tour" }));
    expect(id).toBe("my-tour");
    const got = await store.get("my-tour");
    expect(got?.createdAt).toBe("2026-07-06T12:00:00.000Z");
  });

  it("returns undefined for an unknown id", async () => {
    const store = createWalkthroughStore({ dir });
    expect(await store.get("nope")).toBeUndefined();
  });

  it("rejects a malformed walkthrough", async () => {
    const store = createWalkthroughStore({ dir });
    await expect(store.save({ title: "", steps: [] } as unknown as Walkthrough)).rejects.toThrow(
      /title/,
    );
    await expect(
      store.save({ title: "T", steps: [{ file: "a.py" }] } as unknown as Walkthrough),
    ).rejects.toThrow(/prose|range/);
    await expect(store.save({ title: "T", steps: [] } as unknown as Walkthrough)).rejects.toThrow(
      /steps/,
    );
  });

  it("skips a bad file on disk in list() and logs it", async () => {
    const logs: string[] = [];
    const store = createWalkthroughStore({ dir, newId: () => "ok", log: (l) => logs.push(l) });
    await store.save(validWalkthrough({ id: "good" }));
    // Drop a corrupt file next to the good one.
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");

    const list = await store.list();
    expect(list.map((w) => w.id)).toEqual(["good"]);
    expect(logs.some((l) => l.includes("broken.json"))).toBe(true);
  });

  it("list() is empty (not an error) when the dir does not exist yet", async () => {
    const store = createWalkthroughStore({ dir });
    expect(await store.list()).toEqual([]);
  });
});
