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
  /** Every secret question asked, as `title|emptyMeans` — the paste-or-Enter
   * shape is only observable through what the prompt offered. */
  asked: string[];
}

function rig(vault: Record<string, string> = {}): Rig & {
  seams: (answers: string[], secrets?: string[]) => KeysInterviewSeams;
} {
  const state: Rig = {
    persisted: [],
    stored: new Map(Object.entries(vault)),
    notes: [],
    warns: [],
    asked: [],
  };
  return {
    ...state,
    seams: (answers, secrets = []) => ({
      ask: () => {
        const next = answers.shift();
        if (next === undefined) {
          throw new Error("interview asked more menu questions than the test scripted");
        }
        return Promise.resolve(next);
      },
      secret: (prompt, options) => {
        state.asked.push(`${prompt.title}|${options?.emptyMeans ?? ""}`);
        return Promise.resolve(secrets.shift() ?? "");
      },
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
    // Only openai is undecided → exactly one question; the user pastes. No menu
    // answer is scripted: an `ask` here would throw, which is the point — the
    // gap-fill never puts a letter key between the user and the paste.
    const updated = await ensureKeyDecisions(config, r.seams([], ["sk-pasted"]), {});
    expect(r.persisted).toEqual([["openai", "vault"]]);
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-pasted");
    expect(updated.keys?.openai).toBe("vault");
    expect(updated.keys?.gemini).toBe("skip"); // untouched
    expect(r.asked).toEqual(["OpenAI API key (OPENAI_API_KEY)|skip OpenAI"]);
  });

  it("an empty line IS the skip: it persists and prints the revisit instructions", async () => {
    const r = rig();
    const updated = await ensureKeyDecisions(
      { keys: { openai: "vault", gemini: "vault" } },
      r.seams([], [""]),
      {},
    );
    expect(r.persisted).toEqual([["elevenlabs", "skip"]]);
    expect(updated.keys?.elevenlabs).toBe("skip");
    expect(r.notes.some((n) => n.includes("aiui keys interview"))).toBe(true);
    expect(r.warns).toEqual([]); // an empty line is an answer, not a mistake
  });

  it("whitespace-only input reads as the skip too", async () => {
    const r = rig();
    const updated = await ensureKeyDecisions(
      { keys: { openai: "vault", gemini: "vault" } },
      r.seams([], ["   "]),
      {},
    );
    expect(updated.keys?.elevenlabs).toBe("skip");
    expect(r.stored.has("ELEVEN_LABS_API_KEY")).toBe(false);
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
    const seams = { ...r.seams([], ["sk-pasted"]), mode: "installed" as const };
    const updated = await ensureKeyDecisions(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      seams,
      { OPENAI_API_KEY: "sk-from-env" }, // present, but installed mode does not consult it
    );
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-pasted");
    expect(updated.keys?.openai).toBe("vault");
  });

  it("a failed verify leaves the provider undecided", async () => {
    // A store whose read-back disagrees: no decision persisted at all. The
    // lookup must answer null BEFORE the store (the adopt-existing check) and
    // the corrupted value after it.
    const bad = rig();
    const seams = bad.seams([], ["sk-good"]);
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

  it("a keyless provider gets the bare paste-or-Enter question, no menu at all", async () => {
    const r = rig();
    // Every provider keyless and no env: with nothing to keep and nothing to
    // import there is no third answer, so all three are asked the same way the
    // gap-fill asks. Zero menu answers scripted — an `ask` would throw.
    await runKeysInterview({}, r.seams([], ["sk-new", "", ""]), {});
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-new");
    expect(r.persisted).toEqual([
      ["openai", "vault"],
      ["gemini", "skip"],
      ["elevenlabs", "skip"],
    ]);
    expect(r.asked.every((q) => q.includes("|skip "))).toBe(true);
  });

  it("Enter alone at the replace prompt returns to the choices, storing nothing", async () => {
    const r = rig({ OPENAI_API_KEY: "sk-old" });
    // openai: choose replace, then answer the paste prompt with an empty line
    // (the prompt offers exactly that) → back to the menu, where keep is taken.
    await runKeysInterview(
      { keys: { gemini: "skip", elevenlabs: "skip" } },
      // Two menu answers (replace, then keep); the empty lines answer the paste
      // prompt and then the other two providers' bare questions.
      { ...r.seams(["r", "k"], ["", "", ""]), mode: "installed" },
      {},
    );
    expect(r.stored.get("OPENAI_API_KEY")).toBe("sk-old"); // untouched
    expect(r.persisted[0]).toEqual(["openai", "vault"]);
    expect(r.warns).toEqual([]); // an offered answer is not an error
  });

  it("keeps the menu where there IS a third answer — an importable $VAR", async () => {
    const r = rig();
    // openai and elevenlabs are keyless (bare paste prompt, answered with the
    // empty-line skip); gemini has an importable $VAR, so it — and only it —
    // gets the menu, which the single scripted answer proves.
    await runKeysInterview(
      {},
      { ...r.seams(["e"], ["", ""]), mode: "source" },
      { GEMINI_API_KEY: "g-from-env" },
    );
    expect(r.stored.get("GEMINI_API_KEY")).toBe("g-from-env");
    expect(r.persisted).toEqual([
      ["openai", "skip"],
      ["gemini", "vault"],
      ["elevenlabs", "skip"],
    ]);
  });
});
