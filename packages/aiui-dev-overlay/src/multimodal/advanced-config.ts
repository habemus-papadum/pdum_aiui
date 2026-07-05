/**
 * The advanced config panel — the research surface for the full
 * {@link IntentPipelineConfig}.
 *
 * Rather than design UI for every knob (deferred until dogfooding settles which
 * earn it), the widget's gear opens a **raw JSON editor over the full effective
 * config**, validated strictly on apply: an unknown key or a type mismatch is
 * rejected with a specific, loud message — no silent partial application. The
 * config layers, low → high precedence:
 *
 *   DEFAULT_INTENT_CONFIG  ←  the Vite `intent` option  ←  panel overrides
 *
 * The panel's overrides are the delta the user actually changed (top-level keys
 * that differ from the DEFAULT+Vite base), persisted per-origin in localStorage
 * so un-overridden keys keep tracking the base. "Reset to defaults" clears that
 * layer. The pure pieces (validate / delta / load / save) are exported for the
 * modality and its tests; {@link mountAdvancedConfig} is the DOM.
 *
 * Framework-free, browser-safe.
 */
import { DEFAULT_INTENT_CONFIG, type IntentPipelineConfig } from "../intent-pipeline";

/** localStorage key for the panel's override layer (per origin). */
export const INTENT_CONFIG_STORAGE_KEY = "aiui-intent-config";

// ── strict validation ─────────────────────────────────────────────────────────

type FieldCheck = (value: unknown, key: string) => string | undefined;

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
};

const isFiniteNumber = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value);

const num: FieldCheck = (v, k) =>
  isFiniteNumber(v) ? undefined : `config key "${k}" must be a number (got ${describe(v)})`;
const str: FieldCheck = (v, k) =>
  typeof v === "string" ? undefined : `config key "${k}" must be a string (got ${describe(v)})`;
const bool: FieldCheck = (v, k) =>
  typeof v === "boolean" ? undefined : `config key "${k}" must be a boolean (got ${describe(v)})`;
const strArray: FieldCheck = (v, k) =>
  Array.isArray(v) && v.every((item) => typeof item === "string")
    ? undefined
    : `config key "${k}" must be an array of strings`;
const oneOf =
  (values: readonly string[]): FieldCheck =>
  (v, k) =>
    typeof v === "string" && values.includes(v)
      ? undefined
      : `config key "${k}" must be one of ${values.map((x) => `"${x}"`).join(", ")} (got ${
          typeof v === "string" ? `"${v}"` : describe(v)
        })`;
/** A nested object with a fixed, known set of fields — unknown nested keys reject. */
const objectOf =
  (fields: Record<string, FieldCheck>): FieldCheck =>
  (v, k) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return `config key "${k}" must be an object (got ${describe(v)})`;
    }
    for (const [nestedKey, nestedValue] of Object.entries(v)) {
      const check = fields[nestedKey];
      if (!check) {
        return `unknown config key "${k}.${nestedKey}" — known: ${Object.keys(fields).join(", ")}`;
      }
      const error = check(nestedValue, `${k}.${nestedKey}`);
      if (error) {
        return error;
      }
    }
    return undefined;
  };

/** The known keys of IntentPipelineConfig and how to type-check each. */
const SCHEMA: Record<string, FieldCheck> = {
  talkMode: oneOf(["hold", "toggle"]),
  inkFadeSec: num,
  autoEndSec: num,
  transcriber: oneOf(["mock", "openai"]),
  model: str,
  mockWordMs: num,
  mockTypoRate: num,
  correctionPolicy: oneOf(["replace", "note"]),
  corrector: oneOf(["mock", "openai"]),
  correctionModel: str,
  arming: objectOf({ key: str, enabled: bool }),
  silenceGate: objectOf({ enabled: bool, thresholdDb: num, minSilenceMs: num }),
  priming: objectOf({ sources: strArray }),
  passes: objectOf({ silenceTrim: bool, imageDownscale: bool }),
  diffFlashMs: num,
};

const KNOWN_KEYS = Object.keys(SCHEMA);

/**
 * Validate a candidate config strictly. Every key present must be known and
 * well-typed; a violation rejects loudly, naming the offending key. Missing
 * keys are allowed — they inherit the base layer (this is a delta over the
 * effective config the editor shows). Returns the narrowed partial on success.
 */
export function validateIntentConfig(
  input: unknown,
): { ok: true; config: Partial<IntentPipelineConfig> } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: `config must be a JSON object (got ${describe(input)})` };
  }
  for (const [key, value] of Object.entries(input)) {
    const check = SCHEMA[key];
    if (!check) {
      return {
        ok: false,
        error: `unknown config key "${key}" — check for a typo (known keys: ${KNOWN_KEYS.join(", ")})`,
      };
    }
    const error = check(value, key);
    if (error) {
      return { ok: false, error };
    }
  }
  return { ok: true, config: input as Partial<IntentPipelineConfig> };
}

// ── layering ──────────────────────────────────────────────────────────────────

/**
 * The panel's override layer: the top-level keys of `edited` that differ from
 * `base` (deep compare via JSON). Keys equal to the base, or absent/undefined in
 * `edited`, are omitted — so they keep inheriting DEFAULT+Vite rather than being
 * frozen. This is what gets persisted.
 */
export function computeOverrides(
  edited: Partial<IntentPipelineConfig>,
  base: IntentPipelineConfig,
): Partial<IntentPipelineConfig> {
  const overrides: Record<string, unknown> = {};
  const baseRecord = base as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(edited)) {
    if (value === undefined) {
      continue;
    }
    if (JSON.stringify(value) !== JSON.stringify(baseRecord[key])) {
      overrides[key] = value;
    }
  }
  return overrides as Partial<IntentPipelineConfig>;
}

/** Effective config = DEFAULT ← Vite intent option ← persisted overrides. */
export function effectiveConfig(
  viteOption: Partial<IntentPipelineConfig>,
  overrides: Partial<IntentPipelineConfig>,
): IntentPipelineConfig {
  return { ...DEFAULT_INTENT_CONFIG, ...viteOption, ...overrides };
}

// ── persistence (per origin) ────────────────────────────────────────────────

/** Load the persisted override layer; ignores absent/corrupt/invalid storage. */
export function loadIntentOverrides(
  key: string = INTENT_CONFIG_STORAGE_KEY,
): Partial<IntentPipelineConfig> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const result = validateIntentConfig(JSON.parse(raw));
    return result.ok ? result.config : {};
  } catch {
    return {};
  }
}

export function saveIntentOverrides(
  overrides: Partial<IntentPipelineConfig>,
  key: string = INTENT_CONFIG_STORAGE_KEY,
): void {
  try {
    localStorage.setItem(key, JSON.stringify(overrides));
  } catch {
    // Private mode / no storage — the override just doesn't persist.
  }
}

export function clearIntentOverrides(key: string = INTENT_CONFIG_STORAGE_KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // no-op
  }
}

// ── the panel UI ──────────────────────────────────────────────────────────────

export interface AdvancedConfigOptions {
  /** The DEFAULT+Vite base — the layer the persisted delta sits on. */
  base: IntentPipelineConfig;
  /** The current effective config (base + persisted overrides) at mount. */
  effective: IntentPipelineConfig;
  /** localStorage key for the override layer. */
  storageKey?: string;
  /** Apply a new effective config to the running modality (mutate live). */
  onApply: (effective: IntentPipelineConfig) => void;
}

/**
 * Render the gear + advanced JSON editor into `container` (the widget panel's
 * body). Returns nothing — the panel owns its own state. Applying validates and
 * persists the delta, then calls `onApply` with the new effective config; Reset
 * clears the persisted layer and re-applies the base.
 */
export function mountAdvancedConfig(container: HTMLElement, opts: AdvancedConfigOptions): void {
  const storageKey = opts.storageKey ?? INTENT_CONFIG_STORAGE_KEY;
  let current = opts.effective;

  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "mm-gear";
  gear.textContent = "⚙ advanced config";
  gear.style.cssText =
    "margin-top:8px;border:1px solid #2a3140;background:#171b24;color:#9aa0aa;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;";

  const panel = document.createElement("div");
  panel.className = "mm-config";
  panel.hidden = true;
  panel.style.cssText = "margin-top:8px;";

  const editor = document.createElement("textarea");
  editor.className = "mm-config-editor";
  editor.spellcheck = false;
  editor.style.cssText =
    "width:100%;box-sizing:border-box;min-height:180px;resize:vertical;font:12px/1.5 ui-monospace,monospace;" +
    "background:#14171f;color:#e8e8ea;border:1px solid #2a3140;border-radius:8px;padding:8px;white-space:pre;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "mm-config-apply";
  apply.textContent = "Apply";
  apply.style.cssText =
    "border:none;border-radius:6px;padding:5px 12px;cursor:pointer;background:#8ab4f8;color:#14171f;font:inherit;font-weight:600;";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "mm-config-reset";
  reset.textContent = "Reset to defaults";
  reset.style.cssText =
    "border:1px solid #2a3140;border-radius:6px;padding:5px 12px;cursor:pointer;background:transparent;color:#9aa0aa;font:inherit;";
  const msg = document.createElement("div");
  msg.className = "mm-config-msg";
  msg.style.cssText =
    "margin-left:auto;font-size:11px;color:#9aa0aa;text-align:right;max-width:60%;";
  row.append(apply, reset, msg);

  const hint = document.createElement("div");
  hint.className = "mm-config-hint";
  hint.style.cssText = "margin-top:6px;font-size:11px;color:#6b7280;line-height:1.5;";
  hint.textContent =
    "Full effective config (DEFAULT ← Vite intent option ← your edits). Unknown keys and type mismatches are rejected. Most knobs apply live; transcriber/corrector/model take effect on the next talk. Persisted for this site.";

  panel.append(editor, row, hint);
  container.append(gear, panel);

  const refresh = (): void => {
    editor.value = JSON.stringify(current, null, 2);
  };
  const setMsg = (text: string, isError: boolean): void => {
    msg.textContent = text;
    msg.style.color = isError ? "#f28b82" : "#7ee0a3";
  };
  refresh();

  gear.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      refresh();
    }
  });

  apply.addEventListener("click", () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.value);
    } catch (error) {
      setMsg(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    const result = validateIntentConfig(parsed);
    if (!result.ok) {
      setMsg(result.error, true);
      return;
    }
    const overrides = computeOverrides(result.config, opts.base);
    saveIntentOverrides(overrides, storageKey);
    current = effectiveConfig(opts.base, overrides);
    opts.onApply(current);
    refresh();
    const count = Object.keys(overrides).length;
    setMsg(
      count === 0
        ? "applied — no overrides (matches base)"
        : `applied ✓ (${count} override${count === 1 ? "" : "s"})`,
      false,
    );
  });

  reset.addEventListener("click", () => {
    clearIntentOverrides(storageKey);
    current = effectiveConfig(opts.base, {});
    opts.onApply(current);
    refresh();
    setMsg("reset to defaults ✓", false);
  });
}
