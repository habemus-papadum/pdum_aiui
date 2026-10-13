export type AppMode = "web" | "desktop" | "node-direct";
export interface DesktopBridge {
  info(): Promise<{ platform: string; mode: AppMode; instance: string }>;
  chooseFile(): Promise<string | null>;
  setAlwaysOnTop(enabled: boolean): Promise<boolean>;
  hide(): Promise<void>;
  quit(): Promise<void>;
}
declare global {
  interface Window {
    desktopAPI?: DesktopBridge;
    require?: (specifier: string) => { platform(): string; homedir(): string };
  }
}
