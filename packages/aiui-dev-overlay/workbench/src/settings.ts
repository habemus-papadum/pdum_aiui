/**
 * The settings drawer: every contested interaction-design question, as a
 * knob. The workbench's method is "argue by toggling" — hold-vs-toggle talk,
 * ink fade, auto-end, correction policy, transcriber and its latency — so
 * decisions get made by feel and by the timing pane, not in the abstract.
 * Persisted to localStorage so an opinion survives reloads.
 */
import type { WorkbenchSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const KEY = "aiui-workbench-settings";

export function loadSettings(): WorkbenchSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as object) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: WorkbenchSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

export function settingsPanel(settings: WorkbenchSettings, onChange: () => void): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "wb-settings";
  root.innerHTML = `<div class="wb-insp-tabs"><span style="padding:6px 8px">settings</span></div>`;

  const body = document.createElement("div");
  body.className = "wb-settings-body";
  root.append(body);

  const commit = () => {
    saveSettings(settings);
    onChange();
  };

  body.append(
    select("space bar", ["hold", "toggle"], settings.talkMode, (v) => {
      settings.talkMode = v as WorkbenchSettings["talkMode"];
      commit();
    }),
    number("ink fade (s, 0=keep)", settings.inkFadeSec, (v) => {
      settings.inkFadeSec = v;
      commit();
    }),
    number("auto-end thread (s, 0=off)", settings.autoEndSec, (v) => {
      settings.autoEndSec = v;
      commit();
    }),
    select("transcriber", ["mock", "openai"], settings.transcriber, (v) => {
      settings.transcriber = v as WorkbenchSettings["transcriber"];
      commit();
    }),
    text("openai model", settings.model, (v) => {
      settings.model = v;
      commit();
    }),
    number("mock: ms/word", settings.mockWordMs, (v) => {
      settings.mockWordMs = v;
      commit();
    }),
    number("mock: typo rate 0–1", settings.mockTypoRate, (v) => {
      settings.mockTypoRate = v;
      commit();
    }),
    select("correction policy", ["replace", "note"], settings.correctionPolicy, (v) => {
      settings.correctionPolicy = v as WorkbenchSettings["correctionPolicy"];
      commit();
    }),
    select("corrector", ["mock", "openai"], settings.corrector, (v) => {
      settings.corrector = v as WorkbenchSettings["corrector"];
      commit();
    }),
    text("corrector model", settings.correctionModel, (v) => {
      settings.correctionModel = v;
      commit();
    }),
  );
  return root;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "wb-setting";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function select(
  label: string,
  options: string[],
  value: string,
  set: (v: string) => void,
): HTMLLabelElement {
  const el = document.createElement("select");
  for (const option of options) {
    const o = document.createElement("option");
    o.value = option;
    o.textContent = option;
    o.selected = option === value;
    el.append(o);
  }
  el.addEventListener("change", () => set(el.value));
  return row(label, el);
}

function number(label: string, value: number, set: (v: number) => void): HTMLLabelElement {
  const el = document.createElement("input");
  el.type = "number";
  el.step = "any";
  el.value = String(value);
  el.addEventListener("change", () => {
    const parsed = Number(el.value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      set(parsed);
    }
  });
  return row(label, el);
}

function text(label: string, value: string, set: (v: string) => void): HTMLLabelElement {
  const el = document.createElement("input");
  el.value = value;
  el.addEventListener("change", () => set(el.value.trim()));
  return row(label, el);
}
