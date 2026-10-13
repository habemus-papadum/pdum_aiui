# Electron development workflow

The two application modes can share backend supervision, frontend routing, runtime packaging, and testing. Their difference is the desktop shell and its exposed capabilities. An ordinary web renderer can still power a strongly desktop-specific application.

## Two modes, one runtime contract

**Package mode:** a conventional window displays the frontend. Its browser code calls relative HTTP API paths. The local gateway forwards Express and Python requests to owned processes, and Worker requests to either a local development Worker or a configured remote Worker. The same frontend can run as a website, where an edge gateway supplies those routes instead.

**Desktop mode:** the same gateway and backends run beneath a customized shell. Main-process code owns native windows, the tray, menus, filesystem operations, and process lifecycle. A typed preload bridge exposes specific methods to the renderer. The frontend can use these capabilities when the bridge is present.

Keep `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` in both modes. Desktop APIs do not require renderer Node integration. Electron's main process has the full Node environment; sandboxed preload has a limited Electron/Node subset and delegates privileged work through IPC. [Preload documentation](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload), [sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox/)

Direct renderer Node access is possible, but enabling `nodeIntegration` disables renderer sandboxing. Ordinary renderer `<script type="module">` imports still use Chromium's ESM loader; `import 'node:fs'` does not automatically become a Node import. That option also makes the renderer less portable to the website. This spike recommends the bridge rather than direct Node access. [BrowserWindow preferences](https://www.electronjs.org/docs/latest/api/browser-window/), [Electron ESM loaders](https://www.electronjs.org/docs/latest/tutorial/esm)

Expose one bridge method per capability, rather than raw `ipcRenderer`, unrestricted filesystem access, or a general process-execution method. Share the TypeScript interface with the renderer, validate inputs at runtime, and validate the IPC sender against the owned window and expected origin. TypeScript types disappear at runtime. [Context isolation and TypeScript](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [IPC sender validation](https://www.electronjs.org/docs/latest/tutorial/security/#17-validate-the-sender-of-all-ipc-messages)

## Source-first development and reload

TypeScript remains the source of truth. Electron itself runs generated JavaScript for main/preload; the dev launcher rebuilds these entries automatically. A bundled CommonJS preload is the straightforward choice for a sandboxed renderer, whose preload does not support ESM imports. [Preload ESM limitations](https://www.electronjs.org/docs/latest/tutorial/esm#sandboxed-preload-scripts-cant-use-esm-imports)

The established off-the-shelf option is **electron-vite**. Its dev command builds main/preload, starts a Vite renderer server, and launches Electron. `electron-vite dev --watch` adds main/preload watching. Frontend edits use normal Vite HMR; main edits rebuild and restart Electron; preload edits rebuild and reload the renderer. This is restart/reload rather than live replacement of arbitrary main-process objects. [CLI](https://electron-vite.org/guide/cli), [reload semantics](https://electron-vite.org/guide/hmr-and-hot-reloading)

Another option is **vite-plugin-electron**, which adds Electron entry builds to an ordinary Vite configuration and exposes startup/reload hooks. It is useful when retaining an existing Vite launcher. A custom supervisor can implement the same small boundary with a bundler watcher and owned Electron subprocess, while keeping backend startup independent of renderer rebuilds. [Plugin source and API](https://github.com/electron-vite/vite-plugin-electron)

The desired ownership hierarchy is:

```text
one dev launcher
  ├─ backend processes and gateway
  ├─ Vite renderer server
  ├─ main/preload compiler watchers
  └─ replaceable Electron process
```

Keep the stable backend supervisor outside the restarted Electron process in development. A main restart then preserves backend work and the Vite server. Packaged execution puts the supervisor under Electron, so closing the app closes its owned backends. These are architectural recommendations for this spike, not guarantees supplied by the Electron tools.

## Quiet agents and actual headless execution

`BrowserWindow({ show: false })` creates a real renderer without displaying its window. Agent mode should additionally skip tray creation, automatic DevTools, window activation, and platform UI such as file dialogs. On macOS, hide the Dock icon where appropriate. Hidden windows can throttle background work; tests that depend on animation/timers can explicitly disable background throttling. [Window visibility behavior](https://www.electronjs.org/docs/latest/api/browser-window/#page-visibility)

This is **hidden GUI execution**, not a promise of display-free Electron. Electron's documented Linux CI approach uses a virtual display such as `xvfb-run --auto-servernum ...`; each concurrent run needs a separate display. On macOS, a hidden Electron run still needs the normal GUI environment. Offscreen rendering supplies rendered images/textures, and does not establish a general display-free mode. [Electron headless CI guide](https://github.com/electron/electron/blob/main/docs/tutorial/testing-on-headless-ci.md), [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)

Use ordinary Node/Python HTTP tests for most backend checks and Playwright Chromium for portable frontend behavior. Reserve hidden Electron tests for bridge behavior and actual Electron integration. Playwright's `_electron.launch()` API supports main-process evaluation and renderer automation, but is explicitly experimental. Native dialogs need main-process stubs; browser dialog interception does not handle them. Its debugger requirements can differ from production fuse settings. [Playwright Electron API](https://playwright.dev/docs/api/class-electron)

## Concurrent instances

Allocate listening sockets dynamically, return actual addresses after readiness, and never locate processes by a shared port or process-name pattern. Give each launch its own Electron profile, Worker storage, backend scratch space, and generated entry directory. Set `userData` and `sessionData` before Electron readiness, creating those directories first; otherwise Chromium storage/caches can collide. The generated-code directory matters too: independent ports do not prevent two agents overwriting the same compiled main entry. [Electron profile paths](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path)

Do not use a global single-instance lock in agent mode. Leave debugger ports disabled or allocate them per launch. Cleanup must target owned child handles and must run on failed startup as well as normal exit. Separate checkout/worktree directories remain the clearest way to isolate concurrent source edits.

## Desktop-specific boundaries

Frameless windows are supported directly with `frame: false`. Their draggable regions need `app-region: drag`; interactive controls within those regions need `app-region: no-drag`. Native transparency has platform constraints and should be tested separately from the ordinary frameless shell. [Custom styles](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles), [drag regions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)

A tray application must deliberately keep its process alive after windows close and provide an explicit Quit action. Tray activation behavior varies on Linux, so a portable tray menu is preferable to assuming every platform treats a left click identically. Hidden test mode should omit the tray altogether. [Tray tutorial](https://www.electronjs.org/docs/latest/tutorial/tray), [Tray platform behavior](https://www.electronjs.org/docs/latest/api/tray)
