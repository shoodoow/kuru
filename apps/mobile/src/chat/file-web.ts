/**
 * Files in a browser (the web app and the desktop app built around it).
 * Why: on a phone a file held inside a message is written to the cache folder
 * and handed to the system player, share sheet or photo library. A browser
 * has none of those. It plays and saves from an in-memory address instead
 * (blob:), and Save is a download, which the desktop app turns into a Save As
 * dialog.
 */

/** Addresses already made for bytes that play in place, so a replay does not copy them again. */
const kept = new Map<string, string>();

/**
 * Turns a data: address into a Blob.
 * Input: "data:<mime>;base64,<bytes>" or a plain "data:<mime>,<text>".
 * Output: the Blob, or null when it is not a data: address.
 */
export function dataUrlToBlob(url: string): Blob | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!match) return null;
  const mime = match[1] || "application/octet-stream";
  const body = match[3] ?? "";
  if (/;base64/i.test(match[2] ?? "")) {
    const raw = globalThis.atob(body);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/**
 * An address a <video>, <audio> or new tab can open for bytes held in a message.
 * Input: the data: address, and a key to reuse the address (null makes a fresh one).
 * Output: a blob: address, or the input unchanged when it is not a data: address.
 */
export function playableUrl(url: string, key: string | null): string {
  if (key) {
    const found = kept.get(key);
    if (found) return found;
  }
  const blob = dataUrlToBlob(url);
  if (!blob) return url;
  const made = URL.createObjectURL(blob);
  if (key) kept.set(key, made);
  return made;
}

/**
 * Downloads a file under its name: the browser's download bar, or in the
 * desktop app a Save As dialog.
 * Why the fetch: a browser ignores the download name for an address on
 * another site, and a file streamed from the agent's computer needs the
 * session cookie, so web addresses are read first and saved from memory.
 * Input: a data:, blob: or web address, and the file name.
 */
export async function downloadUrl(url: string, name: string): Promise<void> {
  let href = url;
  let made = false;
  if (url.startsWith("data:")) {
    const blob = dataUrlToBlob(url);
    if (blob) {
      href = URL.createObjectURL(blob);
      made = true;
    }
  } else if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`The file did not load (${response.status}).`);
    href = URL.createObjectURL(await response.blob());
    made = true;
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = name || "download";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has started from the address by now; free the memory a little later.
  if (made) setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Opens a file in a new tab (a new window in the desktop app): pictures, PDFs, text. */
export function openInTab(url: string): void {
  globalThis.open(url, "_blank", "noopener");
}

/**
 * Reads a file the person dropped, pasted or picked into a data: address.
 * Input: a browser File. Output: the data: address.
 */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
}
