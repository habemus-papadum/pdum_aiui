/**
 * The vendor-key conversations — the launch GAP-FILL and the full INTERVIEW —
 * over one engine (the os-vault promotion, 2026-07-20).
 *
 * The division of labor (aiui-util/vendor-keys.ts holds the resolver):
 *  - the OS vault holds the secret bytes (`aiui keys set/unset` mutate it);
 *  - the user config's `keys` section holds the per-provider DECISION —
 *    `"vault"` (in use) or `"skip"` (deliberately unused); absence means
 *    "never interviewed";
 *  - the gap-fill (every interactive `aiui claude`) asks ONLY about undecided
 *    providers: paste a key or skip — and a skip prints how to revisit. In a
 *    source checkout a provider whose key is already in the environment is used
 *    silently (no question, nothing written to the vault); env → vault
 *    migration is exclusively the explicit `aiui keys set` / `aiui keys
 *    interview`. The full interview walks every provider with keep / replace /
 *    skip, and there offers import-from-env because it is user-initiated.
 *
 * Secrets never ride argv here: pastes go through aiui-util's `readSecret`
 * (masked at a TTY, piped otherwise), and every store is verified by an
 * immediate read-back — both platform CLIs' observed failure modes were
 * SILENT corruption, so a write that isn't read back isn't a write.
 */
import {
  readKeyDecisions,
  readSecret,
  resolveVendorKeys,
  VENDOR_KEYS,
  type VendorKeySpec,
  type VendorProvider,
  vaultLookup,
  vaultStore,
  vendorKeysMode,
} from "@habemus-papadum/aiui-util";
import { type AiuiConfig, type KeyDecisionValue, updateUserConfig } from "./config";
import { type Choice, choose, type Prompt } from "./prompt";
import { printNote, printWarning, theme } from "./ui";

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (prompt: Prompt, choices: Choice[]) => Promise<string>;

/** Injectable seams so the interview is testable without a real keychain. */
export interface KeysInterviewSeams {
  ask?: Ask;
  lookup?: (account: string) => Promise<string | null>;
  store?: (account: string, secret: string) => Promise<void>;
  secret?: (label: string) => Promise<string>;
  persist?: (provider: VendorProvider, decision: KeyDecisionValue) => void;
  note?: (message: string) => void;
  warn?: (message: string) => void;
  /** Override the source/installed provenance (defaults to {@link keysMode});
   * lets tests exercise the source-mode env short-circuit deterministically. */
  mode?: "source" | "installed";
}

/** The seams the conversation actually calls, all defaulted. `mode` is a
 * provenance override read directly, not one of these normalized callbacks. */
type NormalizedSeams = Required<Omit<KeysInterviewSeams, "mode">>;

/** Whether THIS aiui resolves keys as the monorepo checkout (env honored) or an
 * install (vault only) — the same signal the channel uses, and the same
 * AIUI_NO_SOURCE_MODE override, so both agree across processes. */
export function keysMode(): "source" | "installed" {
  return vendorKeysMode("@habemus-papadum/aiui");
}

/** Write one decision to the user config (schema-validated path). */
export function persistKeyDecision(provider: VendorProvider, decision: KeyDecisionValue): string {
  return updateUserConfig((config) => {
    config.keys = { ...config.keys, [provider]: decision };
  });
}

const REVISIT_NOTE =
  "revisit anytime: `aiui keys interview` (all providers) or `aiui keys set <provider>` (one key)";

function seams(overrides: KeysInterviewSeams): NormalizedSeams {
  return {
    ask: overrides.ask ?? choose,
    lookup: overrides.lookup ?? ((account) => vaultLookup(account)),
    store: overrides.store ?? ((account, secret) => vaultStore(account, secret)),
    secret: overrides.secret ?? ((label) => readSecret(label)),
    persist:
      overrides.persist ??
      ((provider, decision) => {
        const file = persistKeyDecision(provider, decision);
        (overrides.note ?? printNote)(`wrote keys.${provider}: ${decision} to ${file}`);
      }),
    note: overrides.note ?? ((message) => printNote(message)),
    warn: overrides.warn ?? ((message) => printWarning(message)),
  };
}

/** Store + read-back verify (both platform CLIs fail SILENTLY — see vault.ts).
 * Returns false (with a warning) when the round-trip disagrees. */
async function storeVerified(
  spec: VendorKeySpec,
  secret: string,
  s: NormalizedSeams,
): Promise<boolean> {
  await s.store(spec.envVar, secret);
  const back = await s.lookup(spec.envVar);
  if (back !== secret) {
    s.warn(
      `the OS vault round-trip for ${spec.envVar} did not verify — ` +
        "the stored value disagrees with what was entered; not marking the key as usable",
    );
    return false;
  }
  return true;
}

/**
 * Ask about ONE undecided provider. Returns the decision persisted, or
 * undefined when the exchange ended without one (an empty paste re-asks; a
 * failed verify leaves the provider undecided so the next launch asks again).
 *
 * The gap-fill offers only paste or skip — never "import from the environment".
 * A source checkout with the env var set is handled BEFORE we get here (the
 * launch uses that key at runtime and asks nothing), and installed mode ignores
 * the environment entirely, so env → vault migration is exclusively an explicit
 * act: `aiui keys set` / `aiui keys interview`, never a launch side effect.
 */
async function askUndecided(
  spec: VendorKeySpec,
  s: NormalizedSeams,
): Promise<KeyDecisionValue | undefined> {
  const question: Prompt = {
    title: `Set up the ${spec.label} API key (${spec.envVar})?`,
    detail:
      `It powers ${spec.purpose}. aiui keeps keys in your OS vault (keychain / Secret Service), ` +
      `never in a config file. Skipping just disables ${spec.label}-backed features until you revisit.`,
  };
  const choices: Choice[] = [
    { key: "p", label: "paste the key now (stored in the OS vault, input hidden)" },
    { key: "s", label: `skip — don't use ${spec.label}` },
  ];
  for (;;) {
    const answer = await s.ask(question, choices);
    if (answer === "s") {
      s.persist(spec.provider, "skip");
      s.note(REVISIT_NOTE);
      return "skip";
    }
    const secret = await s.secret(`${spec.envVar}`);
    if (secret.trim() === "") {
      s.warn("empty value — nothing stored");
      continue; // re-present the menu; skip remains the deliberate exit
    }
    if (await storeVerified(spec, secret.trim(), s)) {
      s.persist(spec.provider, "vault");
      return "vault";
    }
    return undefined; // verify failed: leave undecided, the next launch re-asks
  }
}

/**
 * The launch gap-fill: for each provider with NO recorded decision, either
 * defer to an env key (source mode), adopt an existing vault entry silently
 * (it was `aiui keys set` outside an interview, or a pre-decision write), or
 * ask. Call only from an interactive session. Returns the config with any new
 * decisions applied.
 *
 * The launch NEVER writes the environment into the vault or records a decision
 * on the user's behalf for an env-provided key: in a source checkout an
 * exported key already wins at runtime (see aiui-util/vendor-keys.ts), so the
 * gap-fill just uses it and stays silent, leaving the provider undecided — if
 * the env var later disappears, the next launch falls through to the real ask.
 * Migrating env → vault is exclusively `aiui keys set` / `aiui keys interview`.
 */
export async function ensureKeyDecisions(
  config: AiuiConfig,
  overrides: KeysInterviewSeams = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AiuiConfig> {
  const s = seams(overrides);
  const mode = overrides.mode ?? keysMode();
  let keys = { ...config.keys };
  for (const spec of VENDOR_KEYS) {
    if (keys[spec.provider] !== undefined) {
      continue;
    }
    // Source checkout with the env var set: the key resolves at runtime with no
    // vault involvement. Don't prompt, don't write the vault, don't record a
    // decision — just note it and how to persist it deliberately.
    if (mode === "source" && env[spec.envVar]?.trim()) {
      s.note(
        `${theme.good.bold(spec.label)} ${theme.muted("· using")} ${theme.accent(`$${spec.envVar}`)} ` +
          `${theme.muted("from the environment (source checkout) —")} ` +
          `${theme.accent(`aiui keys set ${spec.provider}`)} ${theme.muted("stores it in the OS vault")}`,
      );
      continue;
    }
    let existing: string | null = null;
    try {
      existing = await s.lookup(spec.envVar);
    } catch (err) {
      // An unreachable vault must not block the launch — the channel will
      // degrade keyless; the interview can be re-run when the vault works.
      s.warn(
        `OS vault unavailable while checking ${spec.envVar} — leaving it undecided: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (existing !== null && existing !== "") {
      s.persist(spec.provider, "vault");
      s.note(`${spec.label}: found an existing vault entry for ${spec.envVar} — marked in use`);
      keys = { ...keys, [spec.provider]: "vault" as const };
      continue;
    }
    const decision = await askUndecided(spec, s);
    if (decision !== undefined) {
      keys = { ...keys, [spec.provider]: decision };
    }
  }
  return { ...config, keys };
}

/**
 * The FULL interview (`aiui keys interview`): every provider, current state
 * shown, keep / replace / skip — different from the gap-fill, which only
 * fills silence. Keep is offered only when a usable key exists.
 */
export async function runKeysInterview(
  config: AiuiConfig,
  overrides: KeysInterviewSeams = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const s = seams(overrides);
  const mode = keysMode();
  for (const spec of VENDOR_KEYS) {
    const decision = config.keys?.[spec.provider];
    let stored: string | null = null;
    try {
      stored = await s.lookup(spec.envVar);
    } catch (err) {
      s.warn(
        `OS vault unavailable for ${spec.envVar} — skipping this provider: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const hasKey = stored !== null && stored !== "";
    const envValue = mode === "source" ? env[spec.envVar]?.trim() : undefined;
    const state = [
      decision === undefined ? "never interviewed" : `decision: ${decision}`,
      hasKey ? "vault entry: present" : "vault entry: none",
      ...(envValue ? [`$${spec.envVar} set (wins at runtime in this source checkout)`] : []),
    ].join(" · ");
    const question: Prompt = {
      title: `${spec.label} (${spec.envVar})`,
      detail: `${state}. It powers ${spec.purpose}.`,
    };
    const choices: Choice[] = [
      ...(hasKey ? [{ key: "k", label: "keep the stored key (mark in use)" }] : []),
      { key: "r", label: hasKey ? "replace it — paste a new key" : "paste a key now" },
      ...(envValue ? [{ key: "e", label: `import the value from $${spec.envVar}` }] : []),
      {
        key: "s",
        label:
          `skip — don't use ${spec.label}` +
          (hasKey ? " (the vault entry stays; `aiui keys unset` removes it)" : ""),
      },
    ];
    for (;;) {
      const answer = await s.ask(question, choices);
      if (answer === "k") {
        s.persist(spec.provider, "vault");
        break;
      }
      if (answer === "s") {
        s.persist(spec.provider, "skip");
        s.note(REVISIT_NOTE);
        break;
      }
      const secret = answer === "e" && envValue ? envValue : await s.secret(`${spec.envVar}`);
      if (secret.trim() === "") {
        s.warn("empty value — nothing stored");
        continue;
      }
      if (await storeVerified(spec, secret.trim(), s)) {
        s.persist(spec.provider, "vault");
      }
      break;
    }
  }
  s.note("done — `aiui keys status` shows the result");
}

/** Re-export for the status command: the effective runtime view. */
export async function keysStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ spec: VendorKeySpec; decision?: KeyDecisionValue; source: string }>> {
  const mode = keysMode();
  const resolved = await resolveVendorKeys({ mode, env, onWarn: (m) => printWarning(m) });
  const decisions = readKeyDecisions();
  return VENDOR_KEYS.map((spec) => ({
    spec,
    decision: decisions[spec.provider],
    source: resolved[spec.provider].source,
  }));
}
