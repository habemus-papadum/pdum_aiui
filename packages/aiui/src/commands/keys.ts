/**
 * `aiui keys` — manage the vendor API keys (OpenAI · Gemini · ElevenLabs).
 *
 * The secrets live in the OS vault (macOS login keychain / freedesktop Secret
 * Service — aiui-util/vault.ts); the per-provider DECISION ("vault" = in use,
 * "skip" = deliberately unused) lives in the user config's `keys` section.
 * A source checkout still honors the environment/.env at runtime; an
 * installed aiui reads the vault only.
 *
 *   aiui keys status            per-provider decision + effective source; never values
 *   aiui keys interview         all providers: keep / replace / skip
 *   aiui keys set <provider>    store one key (masked prompt, or piped stdin)
 *   aiui keys unset <provider>  remove the vault entry and mark the provider skipped
 *
 * Secrets never ride argv: `set` reads a masked line at a TTY, one stdin line
 * otherwise (`echo "$OPENAI_API_KEY" | aiui keys set openai`).
 */
import {
  readSecret,
  VENDOR_KEYS,
  type VendorProvider,
  vaultDelete,
  vaultLabel,
  vaultLookup,
  vaultStore,
  vendorKeySpec,
} from "@habemus-papadum/aiui-util";
import { loadAiuiConfig } from "../util/config";
import { keysMode, keysStatus, persistKeyDecision, runKeysInterview } from "../util/keys-interview";
import { printError, printNote, printWarning } from "../util/ui";

function parseProvider(raw: string): VendorProvider {
  const provider = raw.trim().toLowerCase();
  if (provider === "openai" || provider === "gemini" || provider === "elevenlabs") {
    return provider;
  }
  printError(
    `unknown provider "${raw}"`,
    `expected one of: ${VENDOR_KEYS.map((k) => k.provider).join(", ")}`,
  );
  process.exit(2);
}

/** `aiui keys status` — the effective view, sources only. */
export async function runKeysStatus(): Promise<void> {
  const mode = keysMode();
  console.log(
    `mode: ${mode} (${mode === "source" ? "env/.env wins, vault fills gaps" : "OS vault only"})`,
  );
  try {
    console.log(`vault: ${vaultLabel()}`);
  } catch (err) {
    printWarning(err instanceof Error ? err.message : String(err));
  }
  for (const row of await keysStatus()) {
    const decision = row.decision ?? "uninterviewed";
    console.log(
      `  ${row.spec.provider.padEnd(10)} ${row.spec.envVar.padEnd(20)} decision: ${decision.padEnd(13)} source: ${row.source}`,
    );
  }
  console.log(
    "(`aiui keys interview` walks all three; `aiui keys set <provider>` stores one key.)",
  );
}

/** `aiui keys interview` — the full keep/replace/skip pass. Interactive only. */
export async function runKeysInterviewCommand(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printError(
      "the interview is interactive",
      "run it at a terminal; scripted stores go through `aiui keys set <provider>` (stdin)",
    );
    process.exit(2);
  }
  await runKeysInterview(loadAiuiConfig());
}

/** `aiui keys set <provider>` — store one key and mark the provider in use. */
export async function runKeysSet(rawProvider: string): Promise<void> {
  const provider = parseProvider(rawProvider);
  const spec = vendorKeySpec(provider);
  const secret = (await readSecret(spec.envVar)).trim();
  if (secret === "") {
    printError("empty value — nothing stored");
    process.exit(2);
  }
  await vaultStore(spec.envVar, secret);
  // Read-back verify: both platform CLIs' observed failure modes were SILENT
  // corruption (vault.ts), so a write that isn't read back isn't a write.
  const back = await vaultLookup(spec.envVar);
  if (back !== secret) {
    printError(
      `the OS vault round-trip for ${spec.envVar} did not verify`,
      "the stored value disagrees with what was entered — the provider was NOT marked in use",
    );
    process.exit(1);
  }
  const file = persistKeyDecision(provider, "vault");
  printNote(`${spec.envVar} stored in the OS vault; wrote keys.${provider}: vault to ${file}`);
}

/** `aiui keys unset <provider>` — remove the entry, mark the provider skipped. */
export async function runKeysUnset(rawProvider: string): Promise<void> {
  const provider = parseProvider(rawProvider);
  const spec = vendorKeySpec(provider);
  const removed = await vaultDelete(spec.envVar);
  const file = persistKeyDecision(provider, "skip");
  printNote(
    removed
      ? `${spec.envVar} removed from the OS vault; wrote keys.${provider}: skip to ${file}`
      : `no vault entry for ${spec.envVar} (nothing to remove); wrote keys.${provider}: skip to ${file}`,
  );
  printNote(`revisit anytime: \`aiui keys interview\` or \`aiui keys set ${provider}\``);
}
