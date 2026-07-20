/**
 * The vendor-key resolver: the mode table (source honors env; installed
 * ignores it), skip semantics, the tolerant decisions reader, and the
 * never-hang vault guard.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readKeyDecisions, resolveVendorKeys } from "./vendor-keys";

const emptyVault = () => Promise.resolve(null);

describe("resolveVendorKeys — the mode table", () => {
  it("source mode: env wins, vault fills gaps, nothing throws when both are empty", async () => {
    const resolved = await resolveVendorKeys({
      mode: "source",
      env: { OPENAI_API_KEY: "sk-env" },
      decisions: {},
      lookup: (account) => Promise.resolve(account === "GEMINI_API_KEY" ? "g-vault" : null),
    });
    expect(resolved.openai).toMatchObject({ source: "env", value: "sk-env" });
    expect(resolved.gemini).toMatchObject({ source: "vault", value: "g-vault" });
    expect(resolved.elevenlabs).toMatchObject({ source: "missing" });
    expect(resolved.elevenlabs.value).toBeUndefined();
  });

  it("installed mode IGNORES the environment — the vault is the only source", async () => {
    const resolved = await resolveVendorKeys({
      mode: "installed",
      env: { OPENAI_API_KEY: "sk-env-leaked" }, // e.g. leaked through a parent shell
      decisions: {},
      lookup: (account) => Promise.resolve(account === "OPENAI_API_KEY" ? "sk-vault" : null),
    });
    expect(resolved.openai).toMatchObject({ source: "vault", value: "sk-vault" });
    expect(resolved.gemini.source).toBe("missing");
  });

  it("a skip decision silences the vault — but not the env in source mode", async () => {
    // A dev who exports a key has said so more recently than an old interview.
    const withEnv = await resolveVendorKeys({
      mode: "source",
      env: { GEMINI_API_KEY: "g-env" },
      decisions: { gemini: "skip", openai: "skip" },
      lookup: () => Promise.resolve("never-consulted"),
    });
    expect(withEnv.gemini).toMatchObject({ source: "env", value: "g-env" });
    expect(withEnv.openai.source).toBe("skip");

    const installed = await resolveVendorKeys({
      mode: "installed",
      env: { GEMINI_API_KEY: "g-env" },
      decisions: { gemini: "skip" },
      lookup: emptyVault,
    });
    expect(installed.gemini.source).toBe("skip");
    expect(installed.gemini.value).toBeUndefined();
  });

  it("a wedged vault degrades to missing after the timeout — never hangs the boot", async () => {
    const warnings: string[] = [];
    const resolved = await resolveVendorKeys({
      mode: "installed",
      env: {},
      decisions: {},
      lookup: () => new Promise(() => {}), // never settles — a D-Bus-less secret-tool
      timeoutMs: 20,
      onWarn: (m) => warnings.push(m),
    });
    expect(resolved.openai.source).toBe("missing");
    expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
  });

  it("a throwing vault warns and degrades — resolution itself never throws", async () => {
    const warnings: string[] = [];
    const resolved = await resolveVendorKeys({
      mode: "installed",
      env: {},
      decisions: {},
      lookup: () => Promise.reject(new Error("keychain is locked")),
      onWarn: (m) => warnings.push(m),
    });
    expect(resolved.elevenlabs.source).toBe("missing");
    expect(warnings.some((w) => w.includes("keychain is locked"))).toBe(true);
  });
});

describe("readKeyDecisions — tolerant by design (the channel must never die on config)", () => {
  const write = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-keys-test-"));
    const file = join(dir, "config.json");
    writeFileSync(file, content);
    return file;
  };

  it("reads valid decisions and drops junk values", () => {
    const file = write(
      JSON.stringify({
        keys: { openai: "vault", gemini: "skip", elevenlabs: "yes-please", extra: "vault" },
      }),
    );
    expect(readKeyDecisions(file)).toEqual({ openai: "vault", gemini: "skip" });
  });

  it("missing file, malformed JSON, or a missing/mistyped section → {}", () => {
    expect(readKeyDecisions("/nonexistent/config.json")).toEqual({});
    expect(readKeyDecisions(write("{not json"))).toEqual({});
    expect(readKeyDecisions(write(JSON.stringify({ channel: { bind: "loopback" } })))).toEqual({});
    expect(readKeyDecisions(write(JSON.stringify({ keys: "vault" })))).toEqual({});
  });
});
