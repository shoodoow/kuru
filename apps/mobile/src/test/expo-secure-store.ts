// Stands in for the phone's secure storage in tests: an in-memory map.
const values = new Map<string, string>();

export function getItem(key: string): string | null {
  return values.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  values.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  values.delete(key);
}
