import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/contracts.ts";

const bridge: DesktopBridge = {
  info: () => ipcRenderer.invoke("desktop:info"),
  chooseFile: () => ipcRenderer.invoke("desktop:choose-file"),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("desktop:always-on-top", enabled),
  hide: () => ipcRenderer.invoke("desktop:hide"),
  quit: () => ipcRenderer.invoke("desktop:quit"),
};
contextBridge.exposeInMainWorld("desktopAPI", bridge);
