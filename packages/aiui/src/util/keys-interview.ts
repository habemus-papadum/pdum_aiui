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
 *    providers: paste a key, import it from the environment when one is set,
 *    or skip — and a skip prints how to revisit. The full interview
 *    (`aiui keys interview`) walks every provider with keep / replace / skip.
 *
 * Secrets never ride argv here: pastes go through aiui-util's `readSecret`
 * (masked at a TTY, piped otherwise), and every store is verified by an
 * immediate read-back — both platform CLIs' observed failure modes were
 * SILENT corruption, so a write that isn't read back isn't a write.
 */
import {
  packageFromSource,
  readKeyDecisions,
  readSecret,
  resolveVendorKeys,
  VENDOR_KEYS,
  type VendorKeySpec,
  type VendorProvider,
  vaultLookup,
  vaultStore,
} from "@habemus-papadum/aiui-util";
import { type AiuiConfig, type KeyDecisionValue, updateUserConfig } from "./config";
import { type Choice, choose } from "./prompt";
import { printNote, printWarning } from "./ui";

/** Injectable for tests; matches {@link choose} without a default key. */
type Ask = (question: string, choices: Choice[]) => Promise<string>;

/** Injectable seams so the interview is testable without a real keychain. */
export interface KeysInterviewSeams {
  ask?: Ask;
  lookup?: (account: string) => Promise<string | null>;
  store?: (account: string, secret: string) => Promise<void>;
  secret?: (label: string) => Promise<string>;
  persist?: (provider: VendorProvider, decision: KeyDecisionValue) => void;
  note?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Whether THIS aiui runs from the monorepo checkout (env honored) or an
 * install (vault only) — the same provenance signal the channel uses. */
export function keysMode(): "source" | "installed" {
  return packageFromSource("@habemus-papadum/aiui") ? "source" : "installed";
}

/** Write one decision to the user config (schema-validated path). */
export function persistKeyDecision(provider: VendorProvider, decision: KeyDecisionValue): string {
  return updateUserConfig((config) => {
    config.keys = { ...config.keys, [provider]: decision };
  });
}

const REVISIT_NOTE =
  "revisit anytime: `aiui keys interview` (all providers) or `aiui keys set <provider>` (one key)";

function seams(overrides: KeysInterviewSeams): Required<KeysInterviewSeams> {
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
  s: Required<KeysInterviewSeams>,
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
 */
async function askUndecided(
  spec: VendorKeySpec,
  mode: "source" | "installed",
  env: NodeJS.ProcessEnv,
  s: Required<KeysInterviewSeams>,
): Promise<KeyDecisionValue | undefined> {
  const envValue = env[spec.envVar]?.trim();
  const question =
    `One-time setup — the ${spec.label} API key (${spec.envVar}).\n` +
    `It powers ${spec.purpose}. aiui stores keys in your OS vault (keychain / Secret\n` +
    "Service), never in a config file" +
    (mode === "source"
      ? `; in this source checkout the environment/.env still wins at runtime${envValue ? ` (${spec.envVar} is currently set)` : ""}.`
      : ".") +
    `\nSkipping just disables ${spec.label}-backed features until you revisit.`;
  const choices: Choice[] = [
    { key: "p", label: "paste the key now (stored in the OS vault, input hidden)" },
    ...(envValue
      ? [{ key: "e", label: `import the value currently in $${spec.envVar} into the vault` }]
      : []),
    { key: "s", label: `skip — don't use ${spec.label}` },
  ];
  for (;;) {
    const answer = await s.ask(question, choices);
    if (answer === "s") {
      s.persist(spec.provider, "skip");
      s.note(REVISIT_NOTE);
      return "skip";
    }
    const secret = answer === "e" && envValue ? envValue : await s.secret(`${spec.envVar}`);
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
 * adopt an existing vault entry silently (it was `aiui keys set` outside an
 * interview, or a pre-decision write) or ask. Call only from an interactive
 * session. Returns the config with any new decisions applied.
 */
export async function ensureKeyDecisions(
  config: AiuiConfig,
  overrides: KeysInterviewSeams = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AiuiConfig> {
  const s = seams(overrides);
  const mode = keysMode();
  let keys = { ...config.keys };
  for (const spec of VENDOR_KEYS) {
    if (keys[spec.provider] !== undefined) {
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
    const decision = await askUndecided(spec, mode, env, s);
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
    const question = `${spec.label} (${spec.envVar}) — ${state}\nIt powers ${spec.purpose}.`;
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
