import { mkdirSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Dev-server proxy for real transcription: the browser POSTs audio bytes to
 * `/api/transcribe?model=…` and the key stays server-side (OPENAI_API_KEY in
 * the dev server's env — never in the page). Without a key the endpoint says
 * so with a 501 and the workbench sticks to the mock transcriber. This is
 * also a preview of the real architecture: production lowering runs
 * server-side in the channel, not in the browser.
 */
function transcribeProxy(): Plugin {
  const wrap =
    (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    };
  return {
    name: "workbench-transcribe-proxy",
    configureServer(server) {
      server.middlewares.use("/api/transcribe", wrap(handleTranscribe));
      server.middlewares.use("/api/chat", wrap(handleChat));
      server.middlewares.use("/api/shot", wrap(handleShotSave));
      server.middlewares.use("/api/preview", wrap(handlePreview));
    },
  };
}

/**
 * Minimal chat-completions proxy for the correction micro-pipeline (see
 * src/correct.ts): the browser sends {model, messages}, the key stays in the
 * dev server's env / .env.dev, and the reply is flattened to {content}.
 */
async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("content-type", "application/json");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "POST {model, messages} here" }));
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.statusCode = 501;
    res.end(
      JSON.stringify({
        error: "OPENAI_API_KEY is not set in the dev server's environment — mock corrector only",
      }),
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    model?: string;
    messages?: unknown;
  };
  const started = Date.now();
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: body.model, messages: body.messages, temperature: 0 }),
  });
  const payload = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!upstream.ok || payload.error) {
    res.statusCode = upstream.status;
    res.end(JSON.stringify({ error: payload.error?.message ?? `http ${upstream.status}` }));
    return;
  }
  res.end(
    JSON.stringify({
      content: payload.choices?.[0]?.message?.content ?? "",
      upstreamMs: Date.now() - started,
    }),
  );
}

/**
 * Screenshots land as real files in the OS temp dir, so the lowered prompt's
 * Option-C meta carries genuine **absolute paths** — the same contract the
 * production channel uses (archive/channel-attachment-path-encoding.md).
 */
const SHOT_DIR = join(tmpdir(), "aiui-workbench");
let shotCounter = 0;

async function handleShotSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("content-type", "application/json");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "POST png bytes here" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  mkdirSync(SHOT_DIR, { recursive: true });
  const path = join(SHOT_DIR, `${Date.now()}-shot_${++shotCounter}.png`);
  await writeFile(path, Buffer.concat(chunks));
  res.end(JSON.stringify({ path }));
}

/**
 * Hover previews for absolute paths shown in the inspector. Same narrow rules
 * as the channel debugger's endpoint: absolute, image extension, and (post-
 * symlink) inside the workbench shot dir — nothing else is ever served.
 */
async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const raw = url.searchParams.get("path") ?? "";
  const okExt = /\.(png|jpe?g|gif|webp|svg)$/i.test(raw);
  let real: string | undefined;
  try {
    real = isAbsolute(raw) && okExt ? realpathSync(raw) : undefined;
  } catch {}
  let root: string | undefined;
  try {
    root = realpathSync(SHOT_DIR);
  } catch {}
  if (!real || !root || !(real === root || real.startsWith(root + sep))) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not previewable" }));
    return;
  }
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  res.setHeader("content-type", types[extname(real).toLowerCase()] ?? "application/octet-stream");
  res.end(await readFile(real));
}

async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("content-type", "application/json");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "POST audio bytes here" }));
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.statusCode = 501;
    res.end(
      JSON.stringify({
        error: "OPENAI_API_KEY is not set in the dev server's environment — mock transcriber only",
      }),
    );
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const model = url.searchParams.get("model") ?? "gpt-4o-mini-transcribe";
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const type = req.headers["content-type"] ?? "audio/webm";
  const form = new FormData();
  // OpenAI sniffs the container from the filename extension, so it must match
  // the actual bytes (Chrome records webm/opus; Safari mp4; tests send wav).
  const ext = AUDIO_EXT[(type.split(";")[0] ?? "").trim()] ?? "webm";
  form.append("file", new File([new Blob([Buffer.concat(chunks)], { type })], `segment.${ext}`));
  form.append("model", model);

  const started = Date.now();
  const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  res.statusCode = upstream.status;
  res.end(JSON.stringify({ upstreamMs: Date.now() - started, model, result: parsed }));
}

const AUDIO_EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};

export default defineConfig(() => {
  // The key can live in the repo-root .env.dev (gitignored) instead of your
  // shell: OPENAI_API_KEY=sk-… . The file wins over an inherited env var so a
  // stale export can't shadow it.
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const env = loadEnv("dev", repoRoot, "");
  if (env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }
  return { plugins: [transcribeProxy()] };
});
