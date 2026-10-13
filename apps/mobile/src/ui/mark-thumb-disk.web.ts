// The browser's version of mark-thumb-disk.ts. A page has no cache folder, so
// baked avatars are kept in memory as they arrive and baked again on the next
// visit; that takes a moment and needs no connection.

export async function hydrateMarkThumbsFromDisk(_load: (key: string, fileUri: string) => void): Promise<void> {}

export function persistMarkThumb(_key: string, _dataUrl: string): string | null {
  return null;
}
