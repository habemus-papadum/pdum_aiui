/**
 * session-name.test.ts — the generator's shape and the load-or-create reuse
 * contract (the "reconnecting to a known channel keeps the name" invariant).
 */
import { describe, expect, it } from "vitest";
import {
  generateSessionName,
  loadOrCreateSessionName,
  type NameStore,
  sessionNameKey,
} from "./session-name";

function memoryStore(): NameStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

describe("generateSessionName", () => {
  it("is adjective-animal, deterministic under an injected random", () => {
    expect(generateSessionName(() => 0)).toBe("amber-badger");
    expect(generateSessionName(() => 0.999999)).toBe("zippy-yak");
    expect(generateSessionName(() => 0.5)).toMatch(/^[a-z]+-[a-z]+$/);
  });
});

describe("sessionNameKey", () => {
  it("scopes by window and channel identity; the page tier has no window", () => {
    expect(sessionNameKey("/proj/a", 7)).toBe("aiui2.sessionName:7:/proj/a");
    expect(sessionNameKey("port:5099")).toBe("aiui2.sessionName:page:port:5099");
  });
});

describe("loadOrCreateSessionName", () => {
  it("mints once, then reuses — and a stored rename wins", async () => {
    const store = memoryStore();
    const key = sessionNameKey("/proj/a", 1);
    const first = await loadOrCreateSessionName(store, key, () => 0.25);
    expect(store.data.get(key)).toBe(first);
    // A later load (the reconnect) returns the stored name, no regeneration.
    expect(await loadOrCreateSessionName(store, key, () => 0.75)).toBe(first);
    // The user's rename is what future loads see.
    await store.set(key, "renamed-otter");
    expect(await loadOrCreateSessionName(store, key)).toBe("renamed-otter");
  });

  it("treats a blank stored value as absent", async () => {
    const store = memoryStore();
    const key = sessionNameKey("s");
    await store.set(key, "   ");
    expect(await loadOrCreateSessionName(store, key, () => 0)).toBe("amber-badger");
    expect(store.data.get(key)).toBe("amber-badger");
  });
});
