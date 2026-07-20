/**
 * The vault backends over a FAKE runner — the per-platform CLI quirks the
 * exploration paid for live (exploration/os-vault/RESEARCH.md), pinned:
 * macOS's unconditional trailing-newline on read and exit-44 not-found;
 * Linux's byte-exact read and bare-exit-1-no-stderr not-found. Platform
 * selection is by process.platform, so each suite runs only on its platform's
 * CI runner; the fake-runner behavior tests below are platform-gated the same
 * way rather than mocked around.
 */
import { describe, expect, it } from "vitest";
import { type ToolRunner, vaultDelete, vaultLookup, vaultStore } from "./vault";

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

function fakeRunner(
  respond: (call: Call) => { code: number | null; stdout?: string; stderr?: string },
): { runner: ToolRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ToolRunner = (cmd, args, opts) => {
    const call = { cmd, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) };
    calls.push(call);
    const r = respond(call);
    return Promise.resolve({ code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  };
  return { runner, calls };
}

const darwin = process.platform === "darwin";
const linux = process.platform === "linux";

describe.runIf(darwin)("macOS backend (security CLI, faked)", () => {
  it("store passes the secret via argv (never stdin — the double-prompt corruption)", async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0 }));
    await vaultStore("OPENAI_API_KEY", "sk-secret", { runner, service: "svc-test" });
    expect(calls[0].cmd).toBe("security");
    expect(calls[0].args).toContain("add-generic-password");
    const w = calls[0].args.indexOf("-w");
    expect(calls[0].args[w + 1]).toBe("sk-secret");
    expect(calls[0].input).toBeUndefined();
    expect(calls[0].args).toContain("-U"); // idempotent update-in-place
  });

  it("lookup strips exactly the one trailing newline `security -w` appends", async () => {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: "sk-secret\n" }));
    await expect(vaultLookup("OPENAI_API_KEY", { runner })).resolves.toBe("sk-secret");
    // …and never more than one (a hypothetical clean output stays untouched).
    const clean = fakeRunner(() => ({ code: 0, stdout: "sk-secret" }));
    await expect(vaultLookup("OPENAI_API_KEY", { runner: clean.runner })).resolves.toBe(
      "sk-secret",
    );
  });

  it("exit 44 (or the keychain not-found stderr) reads as absent, not an error", async () => {
    const byCode = fakeRunner(() => ({ code: 44, stderr: "" }));
    await expect(vaultLookup("GEMINI_API_KEY", { runner: byCode.runner })).resolves.toBeNull();
    const byText = fakeRunner(() => ({
      code: 1,
      stderr: "The specified item could not be found in the keychain.",
    }));
    await expect(vaultDelete("GEMINI_API_KEY", { runner: byText.runner })).resolves.toBe(false);
  });

  it("a real failure surfaces stderr", async () => {
    const { runner } = fakeRunner(() => ({ code: 51, stderr: "keychain is locked" }));
    await expect(vaultLookup("OPENAI_API_KEY", { runner })).rejects.toThrow(/keychain is locked/);
  });

  it("a missing binary becomes the platform's install hint", async () => {
    const runner: ToolRunner = () => {
      const err = new Error("spawn security ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    };
    await expect(vaultLookup("OPENAI_API_KEY", { runner })).rejects.toThrow(/not found on PATH/);
  });
});

describe.runIf(linux)("Linux backend (secret-tool, faked)", () => {
  it("store sends the secret via stdin, verbatim, with no trailing newline", async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0 }));
    await vaultStore("OPENAI_API_KEY", "sk-secret", { runner, service: "svc-test" });
    expect(calls[0].cmd).toBe("secret-tool");
    expect(calls[0].input).toBe("sk-secret"); // exactly — no "\n"
    expect(calls[0].args).toEqual([
      "store",
      "--label",
      "aiui-keys: OPENAI_API_KEY",
      "service",
      "svc-test",
      "account",
      "OPENAI_API_KEY",
    ]);
  });

  it("lookup is byte-exact — nothing stripped (spawn's pipe is never a tty)", async () => {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: "sk-secret" }));
    await expect(vaultLookup("OPENAI_API_KEY", { runner })).resolves.toBe("sk-secret");
  });

  it("non-zero exit with EMPTY stderr is not-found; with stderr text it is a failure", async () => {
    const notFound = fakeRunner(() => ({ code: 1, stderr: "" }));
    await expect(vaultLookup("OPENAI_API_KEY", { runner: notFound.runner })).resolves.toBeNull();
    await expect(vaultDelete("OPENAI_API_KEY", { runner: notFound.runner })).resolves.toBe(false);
    const failure = fakeRunner(() => ({ code: 1, stderr: "cannot connect to secret service" }));
    await expect(vaultLookup("OPENAI_API_KEY", { runner: failure.runner })).rejects.toThrow(
      /secret service/,
    );
  });
});
