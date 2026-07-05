/**
 * The workbench, assembled: scenery + overlay engine + all the surfaces in
 * one page, so the whole multimodal loop is designable by using it.
 *
 *   `      arm / disarm          Space  talk (hold or toggle — settings)
 *   drag   ink                   S      hold+drag region shot / tap viewport shot
 *   C      clear ink             E      correct mode (lasso the transcript)
 *   Enter  send thread           Esc    step out
 */
import {
  AudioCapture,
  type Corrector,
  Ink,
  locateComponents,
  MULTIMODAL_STYLES,
  mockCorrector,
  mockTranscriber,
  Preview,
  ShotTool,
  type Transcriber,
} from "@habemus-papadum/aiui-dev-overlay";
import { EventPanes, engineSource } from "@habemus-papadum/aiui-dev-overlay/debug-ui";
import {
  composeIntent,
  Engine,
  installKeymap,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { openaiCorrector } from "./correct";
import { mountScenery } from "./scenery";
import { loadSettings, settingsPanel } from "./settings";
import { STYLES } from "./styles";
import { openaiTranscriber } from "./transcribe";

// ── page ─────────────────────────────────────────────────────────────────────
// The overlay owns the ink/shot/preview layer styles now (mm-*); the lab adds
// its scenery + dock (shared debug panes) + settings chrome on top.
const style = document.createElement("style");
style.textContent = `${MULTIMODAL_STYLES}\n${STYLES}`;
document.head.append(style);

const scenery = document.createElement("div");
scenery.id = "wb-scenery";
document.body.append(scenery);
mountScenery(scenery);

// ── core ─────────────────────────────────────────────────────────────────────
const settings = loadSettings();
const engine = new Engine(settings);
const audio = new AudioCapture();

const transcribers: Record<string, Transcriber> = {
  mock: mockTranscriber({
    wordMs: () => settings.mockWordMs,
    typoRate: () => settings.mockTypoRate,
  }),
  openai: openaiTranscriber(() => settings.model),
};

// The correction micro-pipeline: selection + instruction → Corrector → V4A
// patch → a correction event carrying the diff (engine falls back to a plain
// replacement when the pipeline errors, so corrections never just vanish).
const correctors: Record<string, Corrector> = {
  mock: mockCorrector(),
  openai: openaiCorrector(() => settings.correctionModel),
};
engine.correctionPipeline = (target, instruction, via) => {
  const corrector = correctors[settings.corrector] ?? correctors.mock;
  // The document is what the user is looking at: the current thread's text
  // runs with earlier corrections already applied — not the raw finals.
  const docLines = composeIntent(engine.events, "replace")
    .items.filter((item) => item.kind === "text")
    .map((item) => item.text ?? "");
  void corrector
    .diff({ docLines, selected: target.original, instruction })
    .then((diff) => engine.correction(target, instruction, via, diff))
    .catch((error: unknown) => {
      engine.events.push({
        at: Date.now(),
        type: "note",
        text: `correction pipeline failed (${corrector.name}): ${
          error instanceof Error ? error.message : String(error)
        } — applied as plain replacement`,
      });
      engine.correction(target, instruction, via);
    });
};

const ink = new Ink({
  fadeSec: () => settings.inkFadeSec,
  onStroke: (points, bounds) => engine.strokeDone(points, bounds),
  onAutoClear: () => engine.inkCleared(true),
});
document.body.append(ink.canvas);

const shots = new ShotTool(ink, (rect, components, thumb, bytes) => {
  // The lab persists the pixels to a real temp path so the lowered prompt's
  // Option-C meta carries genuine absolute paths (the shipping modality uploads
  // the same bytes to the channel, which assigns the path). Best-effort — the
  // shot event still describes itself if the save fails.
  void (async () => {
    let path: string | undefined;
    if (bytes) {
      try {
        // Copy into an ArrayBuffer-backed view so it's a valid BlobPart.
        const body = new Uint8Array(bytes.length);
        body.set(bytes);
        const saved = (await fetch("/api/shot", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Blob([body], { type: "image/png" }),
        }).then((r) => r.json())) as { path?: string };
        path = saved.path;
      } catch {}
    }
    engine.shotDone(rect, components, thumb, path);
  })();
});
document.body.append(shots.veil);

const preview = new Preview(engine);
document.body.append(preview.root);

const dock = document.createElement("div");
dock.className = "wb-dock";
// The shared debug UI (the same panes the DevTools extension embeds), bound to
// the live engine: events / IR / timing + JSON export. It self-injects its
// aiui-dbg-* styles and defaults its path previews to /api/preview.
const panes = new EventPanes({ correctionPolicy: engine.settings.correctionPolicy });
panes.bind(engineSource(engine));
dock.append(panes.root);
dock.append(
  settingsPanel(settings, () => {
    // The only setting that changes what the panes compose is the correction
    // policy; sync it and re-run the IR pass over the current events.
    panes.config.correctionPolicy = settings.correctionPolicy;
    panes.update(engine.events);
  }),
);
document.body.append(dock);

// ── HUD ──────────────────────────────────────────────────────────────────────
const hud = document.createElement("div");
hud.className = "wb-hud";
hud.innerHTML = `
  <button class="wb-arm" title="arm/disarm (\`)">✳</button>
  <span class="wb-state">off</span>
  <canvas class="wb-meter" width="60" height="14"></canvas>
  <span class="wb-keys">\` arm · Space talk · drag ink · S shot · C clear · E correct · ⏎ send · Esc out</span>`;
document.body.append(hud);
const armButton = hud.querySelector<HTMLButtonElement>(".wb-arm");
const stateLabel = hud.querySelector<HTMLSpanElement>(".wb-state");
const meter = hud.querySelector<HTMLCanvasElement>(".wb-meter");
armButton?.addEventListener("click", () => engine.setArmed(!engine.armed));

function renderHud(): void {
  document.body.classList.toggle("wb-armed", engine.armed);
  hud.classList.toggle("armed", engine.armed);
  hud.classList.toggle("talking", engine.talking);
  if (stateLabel) {
    stateLabel.textContent = !engine.armed
      ? "off"
      : `${engine.mode}${engine.talking ? " · REC" : ""}${engine.threadOpen ? " · thread" : ""}`;
  }
  ink.setActive(engine.armed && engine.mode === "ink" && !shooting);
  preview.setCorrectMode(engine.armed && engine.mode === "correct");
  preview.root.classList.toggle("visible", engine.armed);
}

const meterCtx = meter?.getContext("2d") ?? null;
setInterval(() => {
  if (!meterCtx || !meter) {
    return;
  }
  meterCtx.clearRect(0, 0, meter.width, meter.height);
  const level = engine.talking ? audio.level() : 0;
  meterCtx.fillStyle = engine.talking ? "#ff5c87" : "#3a4152";
  meterCtx.fillRect(0, 0, Math.max(2, level * meter.width), meter.height);
}, 80);

// ── talk plumbing ────────────────────────────────────────────────────────────
async function talkStart(): Promise<void> {
  const hasMic = await audio.ensureStream();
  const segment = engine.talkStart();
  if (segment === undefined) {
    return;
  }
  // The mock ignores audio entirely — talking works even without a mic.
  if (hasMic) {
    audio.start();
  }
}

async function talkEnd(): Promise<void> {
  if (!engine.talking) {
    return;
  }
  const segment = currentSegment();
  engine.talkEnd();
  const blob = (await audio.stop()) ?? new Blob([], { type: "audio/webm" });
  const transcriber = transcribers[settings.transcriber] ?? transcribers.mock;
  try {
    const result = await transcriber.transcribe(blob, (text) =>
      engine.transcriptDelta(segment, text),
    );
    engine.transcriptFinal(segment, result.text, result.latencyMs, result.model);
  } catch (error) {
    engine.events.push({
      at: Date.now(),
      type: "note",
      text: `transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    engine.transcriptFinal(segment, "", 0, transcriber.name);
  }
}

function currentSegment(): number {
  for (let i = engine.events.length - 1; i >= 0; i--) {
    const event = engine.events[i];
    if (event.type === "talk-start") {
      return event.segment;
    }
  }
  return 0;
}

// ── keymap ───────────────────────────────────────────────────────────────────
let shooting = false;
installKeymap(
  () => ({
    armed: engine.armed,
    mode: engine.mode,
    talking: engine.talking,
    talkMode: settings.talkMode,
  }),
  (command) => {
    switch (command.cmd) {
      case "arm-toggle":
        engine.setArmed(!engine.armed);
        break;
      case "talk-start":
        void talkStart();
        break;
      case "talk-end":
        void talkEnd();
        break;
      case "shoot-arm":
        if (engine.mode === "ink") {
          shooting = true;
          shots.setArmed(true);
        }
        break;
      case "shoot-release":
        if (shooting && !shots.dragInProgress()) {
          shots.setArmed(false);
          shooting = false;
          // S tapped without a drag: whole viewport.
          void shots.shootViewport();
        } else if (shooting) {
          // Drag still in flight — the veil finishes the shot on pointerup.
          shots.setArmed(false);
          shooting = false;
        }
        break;
      case "ink-clear":
        ink.clear();
        engine.inkCleared(false);
        break;
      case "correct-toggle":
        engine.setMode(engine.mode === "correct" ? "ink" : "correct");
        break;
      case "send":
        engine.send();
        ink.clear();
        break;
      case "step-out":
        if (engine.mode === "ink" && engine.threadOpen) {
          ink.clear();
        }
        engine.stepOut();
        break;
    }
    renderHud();
  },
);

engine.onEvent(() => renderHud());
renderHud();

// ── lab hook ─────────────────────────────────────────────────────────────────
// A tiny handle for fixture capture and headless driving (this is the lab; the
// shipping overlay exposes nothing). `events` is what the debug UI's export
// button serializes; the rest lets a script drive the real pipeline directly.
(window as unknown as { __wb?: unknown }).__wb = {
  engine,
  settings,
  composeIntent,
  ink,
  shots,
  preview,
  locate: locateComponents,
  get events() {
    return engine.events;
  },
};
