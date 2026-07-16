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
 * modality and its tests — framework-free, unchanged by the Solid port;
 * {@link mountAdvancedConfig} is the DOM, Solid-rendered since proposal B2.2
 * (display state — panel visibility, the apply/reset message — lives in
 * signals created INSIDE the render root, ui/widget.tsx-style; the JSON
 * textarea stays an imperative island because the user's caret lives there).
 */

import {
  DEFAULT_TIER,
  expandTier,
  type IntentPipelineConfig,
  TIER_CONTROLLED_KEYS,
  TIER_PRESETS,
} from "@habemus-papadum/aiui-lowering-pipeline";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";

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
  // Surfaced tiers plus the LEGACY names (standard/flagship/live-*) so a
  // persisted config from before the linter pivot still validates — the
  // pre-pivot SCHEMA silently discarded whole override sets over exactly
  // this kind of gap (it never knew the live tiers).
  tier: oneOf(["mock", "rapid", "premium", "standard", "flagship", "live-gemini", "live-openai"]),
  talkMode: oneOf(["hold", "toggle"]),
  inkFadeSec: num,
  autoEndSec: num,
  transcriber: oneOf(["mock", "openai", "openai-realtime", "openai-voice", "elevenlabs"]),
  model: str,
  keywords: strArray,
  realtimeModel: str,
  realtimeDelay: oneOf(["minimal", "low", "medium", "high", "xhigh"]),
  mockWordMs: num,
  mockTypoRate: num,
  audioBack: oneOf(["off", "acks", "voice"]),
  ttsModel: str,
  ttsVoice: str,
  realtimeVoiceModel: str,
  realtimeVoice: str,
  realtimeTools: oneOf(["none", "submit_intent", "page"]),
  realtimeReasoning: oneOf(["minimal", "low", "medium", "high"]),
  linter: oneOf(["off", "openai", "gemini"]),
  linterModel: str,
  linterInstructions: str,
  videoFrameIntervalMs: num,
  videoMode: oneOf(["smart", "continuous"]),
  arming: objectOf({ key: str, enabled: bool }),
  silenceGate: objectOf({ enabled: bool, thresholdDb: num, minSilenceMs: num }),
  priming: objectOf({ sources: strArray }),
  passes: objectOf({ silenceTrim: bool, imageDownscale: bool }),
  shotFormat: oneOf(["xml", "text"]),
  // Legacy realtime-submode fields (pre-linter configs must still validate).
  submode: oneOf(["transcription", "realtime"]),
  liveVendor: oneOf(["gemini", "openai"]),
  liveModel: str,
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

/**
 * Effective config = `DEFAULT ← expandTier(tier) ← explicit`, where the explicit
 * layer is the Vite `intent` option ∪ the persisted/agent overrides (the
 * non-default layers, i.e. "set on purpose"). The tier preset fills the fine
 * fields *above* the defaults but *below* anything explicit, so a `tier` picks a
 * cost-sized preset while an explicit fine field still wins
 * (`{ tier:"flagship", model:"whisper-1" }` runs flagship but pins `model`).
 *
 * The subtlety this exact shape solves (model-tiers.md, choice #4): the tier must
 * expand at the **delta** level, not the merged level — once layers are merged,
 * every field has a value and "the user set `model`" is indistinguishable from
 * "`DEFAULT` provided `model`". So `viteOption` must be the **raw** Vite partial,
 * never a pre-merged `DEFAULT+vite` object; passing a pre-merged base here would
 * make every field look explicit and the preset would never apply.
 */
export function effectiveConfig(
  viteOption: Partial<IntentPipelineConfig>,
  overrides: Partial<IntentPipelineConfig>,
): IntentPipelineConfig {
  const explicit = { ...viteOption, ...overrides };
  const tier = explicit.tier ?? DEFAULT_TIER;
  return { ...expandTier(tier), ...explicit };
}

/**
 * The persisted delta for an Apply — {@link computeOverrides} plus the
 * **tier-switch delta reconciliation** (model-tiers.md, choice #5). The JSON
 * editor shows the *fully expanded* effective config, so when a user switches
 * `tier` while the editor still literally holds the previous tier's fine-field
 * values, a naive delta would freeze those stale values as explicit overrides —
 * pinning the old tier's fields onto the new one.
 *
 * The fix: when the applied delta contains a `tier`, drop every tier-controlled
 * fine field from the delta **unless it differs from the new tier's preset**
 * (`TIER_PRESETS[newTier]`, not `base`). A field that equals the new tier's
 * preset value is redundant and re-derived by {@link expandTier}; a field that
 * *diverges* from it is a deliberate cross-tier override and kept (so
 * `set_config({ tier:"flagship", model:"whisper-1" })` keeps `model`). The
 * equivalent user-facing rule: *changing `tier` re-derives the fields that tier
 * owns; only fields you set that diverge from the new tier stick.*
 *
 * Both the gear panel's Apply and the agent's `set_config` call this, so they
 * behave identically.
 */
export function overridesForApply(
  edited: Partial<IntentPipelineConfig>,
  base: IntentPipelineConfig,
): Partial<IntentPipelineConfig> {
  const raw = computeOverrides(edited, base) as Record<string, unknown>;
  const newTier = raw.tier;
  if (typeof newTier !== "string") {
    return raw as Partial<IntentPipelineConfig>;
  }
  const preset = (TIER_PRESETS[newTier as keyof typeof TIER_PRESETS] ?? {}) as Record<
    string,
    unknown
  >;
  const reconciled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "tier" && TIER_CONTROLLED_KEYS.has(key)) {
      // Keep a tier-controlled field only if it diverges from the new tier's
      // preset; otherwise it is redundant (or a stale editor value) and expansion
      // supplies it.
      if (JSON.stringify(value) !== JSON.stringify(preset[key])) {
        reconciled[key] = value;
      }
    } else {
      reconciled[key] = value;
    }
  }
  return reconciled as Partial<IntentPipelineConfig>;
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
  /**
   * The **raw** Vite `intent` partial (NOT pre-merged with DEFAULT) — the tier
   * expansion needs the raw explicit layer to distinguish "set on purpose" from
   * the defaults. The base the persisted delta sits on is derived here as
   * `effectiveConfig(viteOption, {})`.
   */
  viteOption: Partial<IntentPipelineConfig>;
  /**
   * The **live** effective config object — the one the modality mutates in
   * place on every apply (panel, agent `set_config`, the K strip). The editor
   * reads it at open/refresh time, so it always shows the current truth no
   * matter which door last changed it.
   */
  effective: IntentPipelineConfig;
  /** localStorage key for the override layer. */
  storageKey?: string;
  /** Apply a new effective config to the running modality (mutate live). */
  onApply: (effective: IntentPipelineConfig) => void;
}

/** The panel's programmatic surface (the K strip's G opens it). */
export interface AdvancedConfigHandle {
  /** Reveal the editor (as if the gear were clicked), refreshed to the live config. */
  open(): void;
}

/**
 * Inline cssText for the panel's pieces — deliberately local (the gear panel
 * is the one surface styled off styles.ts), carried over verbatim from the
 * vanilla implementation. The message's `color` is appended reactively.
 */
const GEAR_STYLE =
  "margin-top:8px;border:1px solid #2a3140;background:#171b24;color:#9aa0aa;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;";
const EDITOR_STYLE =
  "width:100%;box-sizing:border-box;min-height:180px;resize:vertical;font:12px/1.5 ui-monospace,monospace;" +
  "background:#14171f;color:#e8e8ea;border:1px solid #2a3140;border-radius:8px;padding:8px;white-space:pre;";
const ROW_STYLE = "display:flex;align-items:center;gap:8px;margin-top:6px;";
const APPLY_STYLE =
  "border:none;border-radius:6px;padding:5px 12px;cursor:pointer;background:#8ab4f8;color:#14171f;font:inherit;font-weight:600;";
const RESET_STYLE =
  "border:1px solid #2a3140;border-radius:6px;padding:5px 12px;cursor:pointer;background:transparent;color:#9aa0aa;font:inherit;";
const MSG_STYLE = "margin-left:auto;font-size:11px;text-align:right;max-width:60%;";
const HINT_STYLE = "margin-top:6px;font-size:11px;color:#6b7280;line-height:1.5;";

/** The hint's exact wording, kept out of JSX so whitespace can't drift. */
const HINT_TEXT =
  "Full effective config (DEFAULT ← tier preset ← Vite intent option ← your edits). Set `tier` to a preset (mock/standard/rapid/premium/flagship); explicit fine fields still win. Unknown keys and type mismatches are rejected. Most knobs apply live; transcriber/model take effect on the next talk. Persisted for this site.";

/**
 * Render the gear + advanced JSON editor into `container` (the widget panel's
 * body). The panel owns its own state; the returned handle only exposes
 * `open()`. Applying validates and persists the delta, then calls `onApply`
 * with the new effective config; Reset clears the persisted layer and
 * re-applies the base.
 */
export function mountAdvancedConfig(
  container: HTMLElement,
  opts: AdvancedConfigOptions,
): AdvancedConfigHandle {
  const storageKey = opts.storageKey ?? INTENT_CONFIG_STORAGE_KEY;
  // The base the persisted delta is computed against: DEFAULT ← tier preset ←
  // Vite option. Derived from the raw Vite partial so the tier expansion is
  // included (the panel diffs the editor against this).
  const base = effectiveConfig(opts.viteOption, {});

  // Display state lives in signals created INSIDE the render root (the
  // ui/widget.tsx capture pattern — signals created outside never propagate);
  // the plain `openFlag` stays the synchronous truth the gear toggle reads
  // (Solid 2 batches writes, so a same-tick signal read-back would be stale).
  // The textarea is an imperative island: `refresh()` writes its value
  // through the ref, so `open()` and the click handlers keep the vanilla
  // panel's synchronous editor contents.
  interface PanelApi {
    setOpen(value: boolean): void;
    setMsg(value: { text: string; error: boolean }): void;
  }
  let api: PanelApi | undefined;
  let editorEl: HTMLTextAreaElement | undefined;
  let openFlag = false;

  const refresh = (): void => {
    if (editorEl) {
      editorEl.value = JSON.stringify(opts.effective, null, 2);
    }
  };
  const setPanelOpen = (value: boolean): void => {
    openFlag = value;
    if (value) {
      refresh();
    }
    api?.setOpen(value);
  };

  const applyClick = (): void => {
    if (!editorEl || !api) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorEl.value);
    } catch (error) {
      api.setMsg({
        text: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      });
      return;
    }
    const result = validateIntentConfig(parsed);
    if (!result.ok) {
      api.setMsg({ text: result.error, error: true });
      return;
    }
    const overrides = overridesForApply(result.config, base);
    saveIntentOverrides(overrides, storageKey);
    // onApply mutates opts.effective in place; refresh() then reads it live.
    opts.onApply(effectiveConfig(opts.viteOption, overrides));
    refresh();
    const count = Object.keys(overrides).length;
    api.setMsg({
      text:
        count === 0
          ? "applied — no overrides (matches base)"
          : `applied ✓ (${count} override${count === 1 ? "" : "s"})`,
      error: false,
    });
  };

  const resetClick = (): void => {
    clearIntentOverrides(storageKey);
    opts.onApply(effectiveConfig(opts.viteOption, {}));
    refresh();
    api?.setMsg({ text: "reset to defaults ✓", error: false });
  };

  const Panel = () => {
    const [open, setOpen] = createSignal(false);
    const [msg, setMsg] = createSignal<{ text: string; error: boolean } | undefined>(undefined);
    api = { setOpen, setMsg: (value) => setMsg(value) };
    // Initial #9aa0aa until the first apply/reset speaks — then red on error,
    // green on success, exactly the vanilla setMsg colors.
    const msgColor = (): string => {
      const m = msg();
      return m === undefined ? "#9aa0aa" : m.error ? "#f28b82" : "#7ee0a3";
    };
    return (
      <>
        <button
          type="button"
          class="mm-gear"
          style={GEAR_STYLE}
          onClick={() => setPanelOpen(!openFlag)}
        >
          ⚙ advanced config
        </button>
        <div class="mm-config" style="margin-top:8px;" hidden={!open()}>
          <textarea
            class="mm-config-editor"
            spellcheck={false}
            style={EDITOR_STYLE}
            ref={(el: HTMLTextAreaElement) => (editorEl = el)}
          />
          <div style={ROW_STYLE}>
            <button type="button" class="mm-config-apply" style={APPLY_STYLE} onClick={applyClick}>
              Apply
            </button>
            <button type="button" class="mm-config-reset" style={RESET_STYLE} onClick={resetClick}>
              Reset to defaults
            </button>
            <div class="mm-config-msg" style={`${MSG_STYLE}color:${msgColor()};`}>
              {msg()?.text ?? ""}
            </div>
          </div>
          <div class="mm-config-hint" style={HINT_STYLE}>
            {HINT_TEXT}
          </div>
        </div>
      </>
    );
  };

  // Render into an inert wrapper appended to the container: the widget
  // panel's body holds vanilla siblings (the modality help), and the wrapper
  // keeps Solid's root off their DOM (ui/widget.tsx's precedent). The
  // component body runs synchronously during render(), so the api and the
  // editor ref are populated before mountAdvancedConfig returns.
  const mount = document.createElement("div");
  container.append(mount);
  render(Panel, mount);
  if (!api || !editorEl) {
    throw new Error("advanced config render did not capture its mount points");
  }
  refresh();

  return {
    open(): void {
      setPanelOpen(true);
    },
  };
}
