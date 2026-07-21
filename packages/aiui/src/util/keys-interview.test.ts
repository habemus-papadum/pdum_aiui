/**
 * The vendor-key gap-fill + full interview over injected seams — no real
 * keychain, no real config file, no TTY.
 */
import { describe, expect, it } from "vitest";
import type { AiuiConfig, KeyDecisionValue } from "./config";
import { ensureKeyDecisions, type KeysInterviewSeams, runKeysInterview } from "./keys-interview";

interface Rig {
  persisted: Array<[string, KeyDecisionValue]>;
  stored: Map<string, string>;
  notes: string[];
  warns: string[];
}

function rig(vault: Record<string, string> = {}): Rig & {
  seams: (answers: string[], secrets?: string[]) => KeysInterviewSeams;
} {
  const state: Rig = {
    persisted: [],
    stored: new Map(Object.entries(vault)),
    notes: [],
    warns: [],
  };
  return {
    ...state,
    seams: (answers, secrets = []) => ({
      ask: () => {
        const next = answers.shift();
        if (next === undefined) {
          throw new Error("interview asked more questions than the test scripted");
        }
        return Promise.resolve(next);
      },
      secret: () => Promise.resolve(secrets.shift() ?? ""),
      lookup: (account) => Promise.resolve(state.stored.get(account) ?? null),
      store: (account, secret) => {
        state.stored.set(account, secret);
        return Promise.resolve();
      },
      persist: (provider, decision) => {
        state.persisted.push([provider, decision]);
      },
      note: (m) => state.notes.push(m),
      warn: (m) => state.warns.push(m),
    }),
  };
}

describe("ensureKeyDecisions — the launch gap-fill", () => {
  it("asks ONLY undecided providers; paste stores, verifies, and persists vault", async () => {
    const r = rig();
    const config: AiuiConfig = { keys: { gemini: "skip", elevenlabs: "vault" } };
    // Only openai is undecided → exactly one question; the user pastes.
    const updated = await ensureKeyDecisions(config, r.seams(["p"], ["sk-pasted"]), {});
    expect(r.persisted).toEqual([["openai", "vault"]]);
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-pasted");
    expect(updated.keys?.openai).toBe("vault");
    expect(updated.keys?.gemini).toBe("skip"); // untouched
  });

  it("a skip persists and prints the revisit instructions", async () => {
    const r = rig();
    const updated = await ensureKeyDecisions(
      { keys: { openai: "vault", gemini: "vault" } },
      r.seams(["s"]),
      {},
    );
    expect(r.persisted).toEqual([["elevenlabs", "skip"]]);
    expect(updated.keys?.elevenlabs).toBe("skip");
    expect(r.notes.some((n) => n.includes("aiui keys interview"))).toBe(true);
  });

  it("adopts an existing vault entry silently — no question asked", async () => {
    const r = rig({ OPENAI_API_KEY: "sk-already-there" });
    const updated = await ensureKeyDecisions(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      r.seams([]), // zero questions scripted — an ask would throw
      {},
    );
    expect(r.persisted).toEqual([["openai", "vault"]]);
    expect(updated.keys?.openai).toBe("vault");
  });

  it("source mode + env set: uses it silently — no prompt, no vault write, no decision", async () => {
    const r = rig();
    const seams = { ...r.seams([]), mode: "source" as const }; // zero questions scripted
    const updated = await ensureKeyDecisions(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      seams,
      { OPENAI_API_KEY: "sk-from-env" },
    );
    expect(r.stored.has("OPENAI_API_KEY")).toBe(false); // env never migrated to vault
    expect(r.persisted).toEqual([]); // provider left undecided
    expect(updated.keys?.openai).toBeUndefined();
    expect(r.notes.some((n) => n.includes("aiui keys set openai"))).toBe(true);
  });

  it("installed mode ignores the env: an undecided provider is still asked", async () => {
    const r = rig();
    const seams = { ...r.seams(["p"], ["sk-pasted"]), mode: "installed" as const };
    const updated = await ensureKeyDecisions(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      seams,
      { OPENAI_API_KEY: "sk-from-env" }, // present, but installed mode does not consult it
    );
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-pasted");
    expect(updated.keys?.openai).toBe("vault");
  });

  it("an empty paste re-asks (skip stays the deliberate exit); a failed verify leaves it undecided", async () => {
    const r = rig();
    // First answer pastes an empty value → warn + re-ask; second answer skips.
    const updated = await ensureKeyDecisions(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      r.seams(["p", "s"], [""]),
      {},
    );
    expect(r.warns.some((w) => w.includes("empty value"))).toBe(true);
    expect(updated.keys?.openai).toBe("skip");

    // A store whose read-back disagrees: no decision persisted at all. The
    // lookup must answer null BEFORE the store (the adopt-existing check) and
    // the corrupted value after it.
    const bad = rig();
    const seams = bad.seams(["p"], ["sk-good"]);
    let wrote = false;
    seams.store = () => {
      wrote = true;
      return Promise.resolve();
    };
    seams.lookup = () => Promise.resolve(wrote ? "sk-CORRUPTED" : null);
    const after = await ensureKeyDecisions(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      seams,
      {},
    );
    expect(bad.persisted).toEqual([]);
    expect(after.keys?.openai).toBeUndefined(); // the next launch asks again
  });

  it("an unreachable vault warns and leaves providers undecided — the launch proceeds", async () => {
    const r = rig();
    const seams = r.seams([]);
    seams.lookup = () => Promise.reject(new Error("no D-Bus session"));
    const updated = await ensureKeyDecisions({}, seams, {});
    expect(updated.keys?.openai).toBeUndefined();
    expect(r.warns.filter((w) => w.includes("no D-Bus session"))).toHaveLength(3);
    expect(r.persisted).toEqual([]);
  });
});

describe("runKeysInterview — the full keep/replace/skip pass", () => {
  it("keep marks vault; replace stores the new value; skip records the choice", async () => {
    const r = rig({ OPENAI_API_KEY: "sk-old", GEMINI_API_KEY: "g-old" });
    await runKeysInterview(
      { keys: { openai: "vault", gemini: "vault", elevenlabs: "skip" } },
      r.seams(["k", "r", "s"], ["g-new"]),
      {},
    );
    expect(r.persisted).toEqual([
      ["openai", "vault"],
      ["gemini", "vault"],
      ["elevenlabs", "skip"],
    ]);
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-old"); // kept, untouched
    expect(r.stored.get("GEMINI_API_KEY")).toBe("g-new"); // replaced
  });

  it("a provider with no stored key is offered paste, not keep", async () => {
    const r = rig();
    // Every provider keyless: 3 questions; the scripted answers paste one and
    // skip two. If "keep" were offered the ask stub's key wouldn't match — the
    // menu shape is asserted through the flow completing exactly this way.
    await runKeysInterview({}, r.seams(["r", "s", "s"], ["sk-new"]), {});
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-new");
    expect(r.persisted).toEqual([
      ["openai", "vault"],
      ["gemini", "skip"],
      ["elevenlabs", "skip"],
    ]);
  });
});
