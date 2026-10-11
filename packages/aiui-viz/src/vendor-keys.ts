/**
 * Origin-wide vendor keys, shared by every demo and the dock. Pasted keys
 * take precedence over the dev server's seed. Nothing here sends a key.
 * OpenAI keeps its original slot so existing saved keys still work.
 */
export type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CHANGE_EVENT = "aiui:vendor-key-change";

/** Observe edits from another field in this document or another tab. Values stay in storage. */
export function onVendorKeysChange(listener: () => void): () => void {
  globalThis.addEventListener?.(CHANGE_EVENT, listener);
  globalThis.addEventListener?.("storage", listener);
  return () => {
    globalThis.removeEventListener?.(CHANGE_EVENT, listener);
    globalThis.removeEventListener?.("storage", listener);
  };
}

export function vendorKeyStorageKey(provider: string): string {
  return provider === "openai" ? "aiui.oracle.key" : `aiui.keys.${provider}`;
}

function browserStorage(): KeyStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Read only a pasted key, never the dev seed (which must not be persisted). */
export function pastedVendorKey(
  provider: string,
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): string | undefined {
  try {
    return storage?.getItem(vendorKeyStorageKey(provider))?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Save a pasted key; blank clears just this provider. Returns false if storage is blocked. */
export function setPastedVendorKey(
  provider: string,
  value: string,
  storage: KeyStorage | undefined = browserStorage(),
): boolean {
  if (storage === undefined) return false;
  try {
    const key = vendorKeyStorageKey(provider);
    if (value.trim() === "") storage.removeItem(key);
    else storage.setItem(key, value.trim());
    globalThis.dispatchEvent?.(new Event(CHANGE_EVENT));
    return true;
  } catch {
    return false;
  }
}

/** The dev-only seed, also readable by prebuilt packages (no import.meta.env). */
export function devVendorKey(provider: string, global: unknown = globalThis): string | undefined {
  const key = (global as { __AIUI__?: { devKeys?: Record<string, unknown> } }).__AIUI__?.devKeys?.[
    provider
  ];
  return typeof key === "string" ? key.trim() || undefined : undefined;
}

/** Resolve at connect/request time: pasted key first, then the dev seed. */
export function browserVendorKey(
  provider: string,
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
  global: unknown = globalThis,
): string | undefined {
  return pastedVendorKey(provider, storage) ?? devVendorKey(provider, global);
}
