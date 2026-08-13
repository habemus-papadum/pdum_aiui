// docs-shots — the interactive capture assistant for the docs screenshot list.
//
// Usage: pnpm docs:shots        (macOS only; needs pngpaste — brew install pngpaste)
//
// The narrative list lives in docs/proposals/screenshots.md; this script holds the
// same shots as data and walks the capture session: it shows the list (done = the
// target file already exists in docs/public/), you pick a set (Enter = all
// remaining; re-selecting a done shot redoes it), and for each shot it prints the
// staging blurb and waits while you capture to the CLIPBOARD (Cmd-Shift-Ctrl-4).
// Enter then reads the image via pngpaste, checks dimensions and aspect ratio
// (advisory — you can always keep), stashes the untouched original in
// docs/shots-raw.local/ (gitignored via *.local, so re-crops never need a
// recapture), and writes the optimized (≤1600 px wide) PNG to docs/public/.
// Quit anytime — the next run grays out whatever is on disk.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

interface AspectRule {
  min: number;
  max: number;
  hint: string;
}

interface Shot {
  num: number;
  file: string;
  title: string;
  stage: string;
  aspect: AspectRule;
}

// Aspect classes are advisory guardrails, not gates: wide = a browser window or
// the full desktop; term = a terminal (they vary a lot, so the range is loose);
// panel = a tall panel-only drag-select.
const WIDE: AspectRule = { min: 1.3, max: 2.4, hint: "a wide desktop/browser frame (~16:10)" };
const TERM: AspectRule = { min: 0.9, max: 2.6, hint: "a terminal window" };
const PANEL: AspectRule = { min: 0.3, max: 1.2, hint: "a tall panel-only crop" };

const SHOTS: readonly Shot[] = [
  {
    num: 1,
    file: "loop-hero.png",
    title: "the money shot — the whole loop in one frame",
    stage:
      "Full desktop: the session browser showing the demo with the intent panel open mid-turn " +
      "(2–3 dictated segments plus a screenshot chip), and the Claude Code terminal beside it " +
      "with the lowered briefing just landed. Bump the terminal font so it reads at half scale.",
    aspect: WIDE,
  },
  {
    num: 2,
    file: "key-interview.png",
    title: "terminal: the vendor-key interview mid-question",
    stage:
      "Run `aiui keys interview` and capture at the ElevenLabs paste-or-Enter question. Answer " +
      "with Enter (skip) during the capture and rerun it for real afterwards. Terminal only.",
    aspect: TERM,
  },
  {
    num: 3,
    file: "lowered-prompt.png",
    title: "terminal close-up: the injected briefing",
    stage:
      "Right after a send, capture terminal one showing the [current tab: …] preamble and an " +
      "inline [screenshot located at …] marker in the prose. The same session as shot 01 " +
      "works, framed tighter.",
    aspect: TERM,
  },
  {
    num: 4,
    file: "panel-armed.png",
    title: "the panel freshly opened and armed, empty turn",
    stage:
      "Cmd/Ctrl+. on the demo tab and capture page + panel before saying anything — armed, " +
      "mic idle, no content yet.",
    aspect: WIDE,
  },
  {
    num: 5,
    file: "panel-turn.png",
    title: "a turn mid-composition",
    stage:
      "Dictate two or three segments and take one screenshot between them so the chip sits " +
      "inline in the transcript preview. Capture page + panel before sending.",
    aspect: WIDE,
  },
  {
    num: 6,
    file: "segment-editor.png",
    title: "the segment editor open on one segment",
    stage:
      "Open the segment editor on a mistranscribed segment (mid re-speak if you can catch " +
      "it). Page + panel.",
    aspect: WIDE,
  },
  {
    num: 7,
    file: "engine-picker.png",
    title: "the config strip with the three transcription engines",
    stage:
      "Press K to open the config strip, Scribe v2 selected, all three engines and their " +
      "digits visible. A panel-only drag-select is the right framing here.",
    aspect: PANEL,
  },
  {
    num: 8,
    file: "confidence-heatmap.png",
    title: "low-confidence words tinted in the transcript",
    stage:
      "Dictate something with a proper noun or two on Scribe or GPT-4o Transcribe (not " +
      "Realtime Whisper — no logprobs there) and capture the warm-tinted words. Hold the " +
      "hover tooltip with a raw logprob if you can time it (Screenshot.app's timer helps).",
    aspect: PANEL,
  },
  {
    num: 9,
    file: "element-shot.png",
    title: "an element-located screenshot with source attribution",
    stage:
      "Press D over the demo app and capture the on-page element highlight and/or the " +
      "resulting chip's element/source attribution in the preview. Must be over the aiui app " +
      "so attribution has something to say.",
    aspect: WIDE,
  },
  {
    num: 10,
    file: "video-smart.png",
    title: "screen share running in smart mode",
    stage:
      "Press V to start a share and capture the video badge with smart mode and the cadence " +
      "slider in frame, a sampled frame or two already in the preview.",
    aspect: WIDE,
  },
  {
    num: 11,
    file: "linter-chips.png",
    title: "linter chips and the lint-now button",
    stage:
      "Linter on (openai), compose enough for one or two dismissible chips to appear, and " +
      "capture the chips with the lint-now button in frame.",
    aspect: PANEL,
  },
  {
    num: 12,
    file: "oracle-reply.png",
    title: "the mind strip holding the oracle's last reply",
    stage:
      "Ask the oracle a question about the app and capture after the audio ends, while its " +
      "reply is still on the mind strip. Needs the OpenAI key.",
    aspect: PANEL,
  },
  {
    num: 13,
    file: "pencil-strokes.png",
    title: "pencil strokes over the live page",
    stage:
      "Circle a widget or draw an arrow with the pencil and capture the strokes on the page " +
      "plus the located annotation in the preview.",
    aspect: WIDE,
  },
  {
    num: 14,
    file: "trace-debugger.png",
    title: "a real lowering trace open in the debugger",
    stage:
      "Open the trace debugger on a real turn: the stage list with one intermediate " +
      "representation expanded, and a cost card in frame if the turn used the linter or " +
      "correction.",
    aspect: WIDE,
  },
  {
    num: 15,
    file: "console-dashboard.png",
    title: "the console landing (aiui dashboard)",
    stage:
      "Run `aiui dashboard`: channel facts, the Launch key-presence rows, and the surface " +
      "cards all in frame.",
    aspect: WIDE,
  },
  {
    num: 16,
    file: "page-tools-ledger.png",
    title: "the page-tools ledger (optional)",
    stage:
      "The console's tools page with the demo's registered toolkit and its activity bit " +
      "visible.",
    aspect: WIDE,
  },
  {
    num: 17,
    file: "pencil-ipad.png",
    title: "the iPad drawing through /pencil/ (optional)",
    stage:
      "An iPad on the LAN at /pencil/ drawing on the same page — an iPad screenshot, or a " +
      "photo of the iPad if the posture reads better.",
    aspect: { min: 0.5, max: 1.6, hint: "an iPad frame (photo welcome)" },
  },
  {
    num: 18,
    file: "vscode-jump.png",
    title: "jump mode landing in VS Code (optional)",
    stage:
      "The click on the page and VS Code landed at the authoring source line — a " +
      "split/composite is fine.",
    aspect: WIDE,
  },
];

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_DIR = join(ROOT, "docs/public");
const RAW_DIR = join(ROOT, "docs/shots-raw.local");
const MAX_WIDTH = 1600;

const tty = process.stdout.isTTY === true;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);

function wrap(text: string, width = 86): string {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out.join("\n");
}

const isDone = (shot: Shot) => existsSync(join(PUBLIC_DIR, shot.file));
const pad2 = (n: number) => String(n).padStart(2, "0");

function printList(): void {
  console.log(bold("\ndocs screenshots — docs/proposals/screenshots.md\n"));
  for (const shot of SHOTS) {
    const row = `  ${isDone(shot) ? green("✓") : " "} ${pad2(shot.num)}  ${shot.file.padEnd(26)} ${shot.title}`;
    console.log(isDone(shot) ? dim(row) : row);
  }
  const remaining = SHOTS.filter((s) => !isDone(s)).length;
  console.log(`\n${SHOTS.length - remaining} done, ${remaining} remaining\n`);
}

/** "2 5-8 14" / "all" / "" → the shots to run this session. Null = bad input. */
function parseSelection(input: string): Shot[] | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return SHOTS.filter((s) => !isDone(s));
  if (trimmed === "all") return [...SHOTS];
  const picked = new Set<number>();
  for (const token of trimmed.split(/[\s,]+/)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    const nums = range
      ? Array.from(
          { length: Number(range[2]) - Number(range[1]) + 1 },
          (_, i) => Number(range[1]) + i,
        )
      : [Number(token)];
    for (const n of nums) {
      if (!Number.isInteger(n) || n < 1 || n > SHOTS.length) return null;
      picked.add(n);
    }
  }
  return SHOTS.filter((s) => picked.has(s.num));
}

interface Dims {
  width: number;
  height: number;
}

function imageDims(file: string): Dims {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {
    encoding: "utf8",
  });
  const width = Number(out.match(/pixelWidth: (\d+)/)?.[1]);
  const height = Number(out.match(/pixelHeight: (\d+)/)?.[1]);
  if (!width || !height) throw new Error(`could not read image dimensions of ${file}`);
  return { width, height };
}

function kb(file: string): string {
  return `${Math.round(statSync(file).size / 1024)} KB`;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("docs:shots is macOS-only (pngpaste + sips + the clipboard capture flow).");
    process.exit(2);
  }
  if (spawnSync("which", ["pngpaste"]).status !== 0) {
    console.error("pngpaste is required (it reads the captured image off the clipboard).");
    console.error("Install it:  brew install pngpaste");
    process.exit(2);
  }
  // docs/public/ can be absent on disk (git drops empty dirs, and 7a7d7ac
  // emptied it) — and sips exits 0 even when it cannot write its --out file.
  mkdirSync(PUBLIC_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Stdin EOF must land as a clean quit. readline/promises leaves a pending
  // question() UNSETTLED when the interface closes (no AbortSignal wired), which
  // would drain the event loop and die as an "unsettled top-level await" — so
  // every question races against close, and close answers "q".
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });
  const ask = async (prompt: string): Promise<string> => {
    if (closed) return "q";
    const closeAnswers = new Promise<string>((resolve) => rl.once("close", () => resolve("q")));
    try {
      return await Promise.race([rl.question(prompt), closeAnswers]);
    } catch {
      return "q";
    }
  };

  printList();
  let selection: Shot[] | null = null;
  while (selection === null) {
    const answer = await ask(
      'Which shots? Enter = all remaining · numbers/ranges (e.g. "2 5-8 14") · all · q: ',
    );
    if (answer.trim().toLowerCase() === "q") {
      rl.close();
      return;
    }
    selection = parseSelection(answer);
    if (selection === null) console.log(yellow("didn't parse — numbers 1-18, ranges, or 'all'."));
    else if (selection.length === 0) {
      console.log(green("nothing remaining — select numbers to redo, or q to quit."));
      selection = null;
    }
  }

  let lastHash: string | undefined;
  let i = 0;
  while (i < selection.length) {
    const shot = selection[i];
    console.log(`\n${bold(`=== ${pad2(shot.num)} · ${shot.file} — ${shot.title} ===`)}`);
    console.log(wrap(shot.stage));
    console.log(dim(`target: docs/public/${shot.file} — expected: ${shot.aspect.hint}`));
    if (isDone(shot)) console.log(yellow("already captured — saving will overwrite it"));

    const answer = (
      await ask(
        "Capture to the clipboard (Cmd-Shift-Ctrl-4), then Enter · s skip · r retake previous · q quit: ",
      )
    )
      .trim()
      .toLowerCase();
    if (answer === "q") break;
    if (answer === "s") {
      i += 1;
      continue;
    }
    if (answer === "r") {
      i = Math.max(0, i - 1);
      continue;
    }

    const rawFile = join(RAW_DIR, `${pad2(shot.num)}-${shot.file}`);
    if (spawnSync("pngpaste", [rawFile]).status !== 0) {
      console.log(yellow("no image on the clipboard — capture first, then Enter."));
      continue;
    }

    const hash = createHash("sha256").update(readFileSync(rawFile)).digest("hex");
    if (hash === lastHash) {
      const again = await ask(
        yellow("that's the SAME image as the previous save — use it anyway? y/N: "),
      );
      if (again.trim().toLowerCase() !== "y") continue;
    }

    const dims = imageDims(rawFile);
    const ratio = dims.width / dims.height;
    if (dims.width < 800) {
      console.log(yellow(`only ${dims.width} px wide — that will look soft in the docs.`));
    }
    if (ratio < shot.aspect.min || ratio > shot.aspect.max) {
      const keep = await ask(
        yellow(
          `aspect ${ratio.toFixed(2)} (${dims.width}×${dims.height}) is outside what this ` +
            `shot expects (${shot.aspect.hint}). Keep anyway? y/N: `,
        ),
      );
      if (keep.trim().toLowerCase() !== "y") {
        console.log("okay — recapture and press Enter again.");
        continue;
      }
    }

    const target = join(PUBLIC_DIR, shot.file);
    try {
      if (dims.width > MAX_WIDTH) {
        execFileSync("sips", ["--resampleWidth", String(MAX_WIDTH), rawFile, "--out", target], {
          stdio: "ignore",
        });
      } else {
        copyFileSync(rawFile, target);
      }
      // Read the result back — sips reports per-file write failures as
      // warnings and still exits 0, so an unreadable target is the only signal.
      const final = imageDims(target);
      console.log(
        green(
          `✓ saved docs/public/${shot.file} (${final.width}×${final.height}, ${kb(target)}; ` +
            `original ${dims.width}×${dims.height} kept in docs/shots-raw.local/)`,
        ),
      );
    } catch (err) {
      console.log(
        yellow(
          `saving failed (${err instanceof Error ? err.message : String(err)}) — the raw ` +
            "capture is safe in docs/shots-raw.local/; press Enter to retry.",
        ),
      );
      continue;
    }
    lastHash = hash;
    i += 1;
  }

  rl.close();
  printList();
}

await main();
