/**
 * electron/main.mjs — the Electron main process. DEV MODE ONLY.
 *
 * Deliberately the smallest shell that can hold the app: open a window, point
 * it at the Vite dev server, quit when it closes. No preload, no IPC, no
 * `app://` scheme, no menu — every one of those is a place where the Electron
 * build could start behaving differently from the browser build, and the point
 * of this step is that it doesn't. The renderer running inside this window is
 * byte-for-byte the one `pnpm dev` serves.
 *
 * It is launched by electron/dev.mjs, which starts the dev server first and
 * passes the URL it actually resolved to. Configuration arrives through the
 * environment rather than argv because Electron's own argv parsing treats the
 * first non-switch argument as the app path, and env vars sidestep the question
 * of what may legally follow it.
 *
 *   CC_MINER_URL        where the dev server is listening (required)
 *   CC_MINER_CDP_PORT   Chrome DevTools Protocol port, "" to disable
 *   CC_MINER_DEVTOOLS   "1" to open DevTools detached on start
 *
 * This file will move to a shared package (`aiui-electron-framework`) once the
 * shape has earned it; for now it lives with the one app that uses it.
 */
import { app, BrowserWindow, shell } from "electron";

const url = process.env.CC_MINER_URL;
if (!url) {
  console.error("[cc-miner/electron] CC_MINER_URL is not set — start via `pnpm dev:electron`.");
  process.exit(2);
}

// Must be appended before the app is ready. NOT 9222: that port belongs to the
// shared aiui session browser, and colliding with it would make `aiui open`
// and the Chrome DevTools MCP attach to this window by mistake.
const cdpPort = process.env.CC_MINER_CDP_PORT ?? "";
if (cdpPort) app.commandLine.appendSwitch("remote-debugging-port", cdpPort);

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // --cco-bg from src/styles.css. Without it the window paints white for a
    // frame or two before the app's dark stylesheet lands, which reads as a
    // flash of broken rendering rather than a load.
    backgroundColor: "#14161a",
    title: "cc-miner",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(url);
  if (process.env.CC_MINER_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });

  // Anything not on the dev server (docs links, an issue tracker) belongs in
  // the user's real browser, not in a chromeless window with no address bar.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

app.whenReady().then(createWindow);

// A dev tool, not a Mac app: closing the window ends the run so `dev.mjs` can
// shut the Vite server down with it.
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
