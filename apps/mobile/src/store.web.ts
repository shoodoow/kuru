// The browser's version of store.ts. Same functions, backed by local storage.
// A private window, or storage turned off, throws on access: every call then
// behaves as if nothing was saved, and the app keeps working until it closes.

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setItem(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Kept in memory by the caller until the page closes.
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  return getItem(key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing was saved.
  }
}
