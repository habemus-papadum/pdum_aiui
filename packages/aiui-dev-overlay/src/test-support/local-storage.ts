/**
 * Test support: a minimal in-memory `localStorage`. This repo's jsdom setup
 * doesn't expose `localStorage`, so any code that persists to it (the advanced
 * config panel) needs one installed for the duration of a test. Returns an
 * uninstall function. Test-only (outside the build/typecheck graph).
 */
export function installLocalStorage(): () => void {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });
  return () => {
    if (had) {
      Object.defineProperty(globalThis, "localStorage", had);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  };
}
