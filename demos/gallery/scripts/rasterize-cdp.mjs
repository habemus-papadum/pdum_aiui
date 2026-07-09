/**
 * rasterize-cdp.mjs — rasterize an SVG to a transparent PNG over the Chrome
 * DevTools Protocol (no deps; Node's global fetch + WebSocket).
 *
 * Chrome 150's single-shot `--screenshot` CLI mode does not reliably emit a
 * file on this build, so we drive a browser directly: navigate to the SVG,
 * override the default page background to fully transparent
 * (Emulation.setDefaultBackgroundColorOverride, alpha 0 — the "no background"
 * ask), and capture. gen-favicon.sh launches a private headless Chrome with a
 * debug port and passes it here; it also works against an already-running
 * browser (e.g. the aiui session browser's DevToolsActivePort).
 *
 *   node rasterize-cdp.mjs <port> <file-url> <out.png> <size>
 */
import { writeFileSync } from "node:fs";

const [, , port, fileUrl, out, sizeArg] = process.argv;
const size = Number(sizeArg ?? 512);

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
// Newer Chrome requires PUT for /json/new; older/lenient builds accept GET.
const newTab = async (verb) => {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: verb });
  if (!r.ok) throw new Error(`/json/new ${verb} → ${r.status}`);
  return r.json();
};
const target = await newTab("PUT").catch(() => newTab("GET"));

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const waiters = new Map();
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const once = (method) =>
  new Promise((res) => {
    const arr = waiters.get(method) ?? [];
    arr.push(res);
    waiters.set(method, arr);
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  } else if (msg.method && waiters.get(msg.method)?.length) {
    const arr = waiters.get(msg.method);
    waiters.set(msg.method, []);
    for (const r of arr) r(msg.params);
  }
});
await new Promise((res) => ws.addEventListener("open", res));

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: size,
  height: size,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Emulation.setDefaultBackgroundColorOverride", {
  color: { r: 0, g: 0, b: 0, a: 0 },
});

const loaded = once("Page.loadEventFired");
await send("Page.navigate", { url: fileUrl });
await Promise.race([loaded, new Promise((r) => setTimeout(r, 3000))]);
await new Promise((r) => setTimeout(r, 300)); // let layout/paint settle

const shot = await send("Page.captureScreenshot", {
  format: "png",
  clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
  captureBeyondViewport: true,
});
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`favicon.png: ${size}x${size} (transparent) via ${ver.Browser} → ${out}`);

await send("Page.close").catch(() => {});
ws.close();
process.exit(0);
