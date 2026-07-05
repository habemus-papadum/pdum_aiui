/**
 * Test support: a minimal in-memory `sessionStorage` (jsdom here exposes
 * neither local- nor sessionStorage). The turn store mirrors an in-progress
 * turn here so it survives a simulated reload. Returns an uninstall function.
 * Test-only (outside the build/typecheck graph).
 */
export function installSessionStorage(): () => void {
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
  const had = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: stub, configurable: true });
  return () => {
    if (had) {
      Object.defineProperty(globalThis, "sessionStorage", had);
    } else {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  };
}
