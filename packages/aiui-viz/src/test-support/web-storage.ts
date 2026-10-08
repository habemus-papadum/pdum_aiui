/**
 * web-storage.ts — vitest setup: a localStorage for the jsdom environment
 * when the runtime took the name first.
 *
 * Node ≥ 25 defines `globalThis.localStorage` as an own accessor that answers
 * `undefined` (with an ExperimentalWarning) unless `--localstorage-file` is
 * set, and vitest's jsdom environment does not install jsdom's over a global
 * that already exists — so every test that persists (the selection views
 * store) saw `undefined.setItem`. Found 2026-10-08 on Node 26; CI's `.nvmrc`
 * Node is unaffected. An in-memory Storage, defined only when the global is
 * missing: the same per-process persistence the tests rely on.
 */
const g = globalThis as { localStorage?: Storage };
if (g.localStorage === undefined) {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(String(key)) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(String(key));
    },
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });
}
