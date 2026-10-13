import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import type { AppMode } from "../shared/contracts.ts";
import { startServices } from "../shared/services.ts";

async function bootstrap() {
  const resourceRoot = app.isPackaged
    ? process.resourcesPath
    : (process.env.APP_ROOT ?? app.getAppPath());
  const config = JSON.parse(readFileSync(join(resourceRoot, "app-config.json"), "utf8"));
  const mode = (process.env.APP_MODE ?? config.mode ?? "web") as AppMode;
  if (!["web", "desktop", "node-direct"].includes(mode)) throw new Error("Unknown APP_MODE");
  const hidden = process.env.APP_HIDDEN === "1";
  const profile = process.env.APP_PROFILE ?? mkdtempSync(join(tmpdir(), "electron-stack-profile-"));
  mkdirSync(join(profile, "session"), { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", join(profile, "session"));
  if (process.platform === "darwin" && (hidden || mode === "desktop"))
    app.setActivationPolicy("accessory");
  let services: Awaited<ReturnType<typeof startServices>> | undefined;
  let pendingServices: ReturnType<typeof startServices> | undefined;
  const startup = new AbortController();
  let window: BrowserWindow;
  let tray: Tray | undefined;
  let closing = false;
  let exited = false;
  let exitCode = 0;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    startup.abort(new Error("Application is shutting down"));
    tray?.destroy();
    // Startup owns detached child groups before it returns a service handle.
    // Its rejection path collects those groups; wait for that before exiting.
    if (pendingServices) await pendingServices.catch(() => undefined);
    await services?.stop();
    if (!process.env.APP_PROFILE) await rm(profile, { recursive: true, force: true });
    exited = true;
    app.exit(exitCode);
  };
  app.on("before-quit", (event) => {
    if (!exited) {
      event.preventDefault();
      void shutdown();
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void shutdown();
    });
  await app.whenReady();
  try {
    const root = resourceRoot;
    let url = process.env.ELECTRON_RENDERER_URL ?? process.env.GATEWAY_URL;
    if (!process.env.GATEWAY_URL) {
      pendingServices = startServices({
        root,
        node: app.isPackaged
          ? join(root, "runtimes/node/bin/node")
          : (process.env.NODE_EXECUTABLE ?? "node"),
        python: app.isPackaged
          ? join(root, "runtimes/python/bin/python3")
          : (process.env.PYTHON ?? "python3"),
        stateDir: profile,
        workerUrl: process.env.WORKER_URL ?? config.workerUrl,
        staticDir: join(__dirname, "../renderer"),
        signal: startup.signal,
        onFailure: (error) => {
          console.error(error);
          exitCode = 1;
          void shutdown();
        },
      });
      services = await pendingServices;
      if (closing) return;
      url = services.url;
    }
    if (!url) throw new Error("Missing frontend URL");
    window = new BrowserWindow({
      width: mode === "desktop" ? 440 : 1050,
      height: mode === "desktop" ? 650 : 740,
      show: !hidden,
      frame: mode !== "desktop",
      alwaysOnTop: mode === "desktop",
      webPreferences: {
        nodeIntegration: mode === "node-direct",
        contextIsolation: mode !== "node-direct",
        sandbox: mode !== "node-direct",
        ...(mode === "desktop" ? { preload: join(__dirname, "../preload/index.cjs") } : {}),
      },
    });
    const document = new URL(url);
    const trustedDocument = (target: string) => {
      try {
        const candidate = new URL(target);
        return candidate.origin === document.origin && candidate.pathname === document.pathname;
      } catch {
        return false;
      }
    };
    window.webContents.on("will-navigate", (event, target) => {
      if (!trustedDocument(target)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, target) => {
      if (!trustedDocument(target)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error("Untrusted IPC sender");
      if (!trustedDocument(event.senderFrame.url)) throw new Error("Untrusted IPC document");
    };
    ipcMain.handle("desktop:info", (event) => {
      trusted(event);
      return {
        platform: process.platform,
        mode,
        instance: services?.instance ?? process.env.DEV_INSTANCE_ID,
      };
    });
    ipcMain.handle("desktop:choose-file", async (event) => {
      trusted(event);
      const result = await dialog.showOpenDialog(window, { properties: ["openFile"] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("desktop:always-on-top", (event, enabled: unknown) => {
      trusted(event);
      if (typeof enabled !== "boolean") throw new Error("Expected boolean");
      window.setAlwaysOnTop(enabled);
      return window.isAlwaysOnTop();
    });
    ipcMain.handle("desktop:hide", (event) => {
      trusted(event);
      window.hide();
    });
    ipcMain.handle("desktop:quit", (event) => {
      trusted(event);
      setTimeout(() => {
        void shutdown();
      }, 0);
    });
    if (mode === "desktop" && !hidden) {
      const icon = nativeImage
        .createFromDataURL(
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
        .resize({ width: 16, height: 16 });
      icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip("Electron Stack Spike");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Show panel", click: () => window.show() },
          { label: "Hide panel", click: () => window.hide() },
          {
            label: "Quit",
            click: () => {
              void shutdown();
            },
          },
        ]),
      );
    }
    window.on("close", (event) => {
      if (mode === "desktop" && !hidden && !closing) {
        event.preventDefault();
        window.hide();
      }
    });
    app.on("window-all-closed", () => {
      if (mode !== "desktop" || hidden) void shutdown();
    });
    await window.loadURL(url);
    console.log(
      JSON.stringify({ type: "electron-ready", mode, hidden, url, profile, pid: process.pid }),
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
    await shutdown();
  }
}
void bootstrap().catch((error) => {
  console.error(error);
  app.exit(1);
});
