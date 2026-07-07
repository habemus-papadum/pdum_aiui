/**
 * App.tsx — the disposable SolidJS shell around the durable Monaco island.
 *
 * Layout: a header, a body split into sidebar (files + outline) · editor column
 * (tabs · breadcrumb · reader) · an optional walkthrough drawer, and a status
 * bar. Plus the global keymap and the command palette. All of this is rebuilt
 * freely on hot edits; the reader island underneath keeps its place.
 */
import { createSignal, onCleanup, Show } from "solid-js";
import { activeWalkthrough, reader } from "../model/store";
import { Breadcrumb } from "./Breadcrumb";
import { CommandPalette } from "./CommandPalette";
import { FileTree } from "./FileTree";
import { Outline } from "./Outline";
import { ReaderPane } from "./ReaderPane";
import { StatusBar } from "./StatusBar";
import { Tabs } from "./Tabs";
import { WalkthroughPanel } from "./Walkthrough";

export function App() {
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteSeed, setPaletteSeed] = createSignal("");

  const openPalette = (seed: string) => {
    setPaletteSeed(seed);
    setPaletteOpen(true);
  };

  // Global keymap — cockpit shortcuts. The palette input owns its own keys; here
  // we only claim chords Monaco doesn't bind in a read-only editor.
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      openPalette("");
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      openPalette("@");
    } else if (mod && e.key === "[") {
      e.preventDefault();
      reader.back();
    } else if (mod && e.key === "]") {
      e.preventDefault();
      reader.forward();
    }
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <div class="app">
      <header class="app-header">
        <span class="app-title">
          <b>aiui</b> · code reader
        </span>
        <button type="button" class="app-search" onClick={() => openPalette("")}>
          Go to file… <kbd>⌘P</kbd>
        </button>
        <span class="app-hint">
          <kbd>⌘⇧O</kbd> symbols · <kbd>F12</kbd> definition · <kbd>⇧F12</kbd> references
        </span>
      </header>
      <div class="app-body">
        <aside class="sidebar">
          <FileTree />
          <Outline />
        </aside>
        <main class="editor-col">
          <Tabs />
          <Breadcrumb />
          <ReaderPane />
        </main>
        <Show when={activeWalkthrough.get()}>
          <aside class="walkthrough-col">
            <WalkthroughPanel />
          </aside>
        </Show>
      </div>
      <StatusBar />
      <CommandPalette
        open={paletteOpen()}
        seed={paletteSeed()}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
