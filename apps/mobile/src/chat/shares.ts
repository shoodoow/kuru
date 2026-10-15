import type { MessageBlock } from "../api";

export type SharedFile = {
  name: string;
  url: string;
  mime?: string;
  conversationId?: string;
  blobRef?: { messageId: string; index: number };
};

export type SharedImage = {
  label: string;
  url: string;
  /** A picture or video that arrived as a file: shown in Media, loaded like the chat loads it. */
  file?: SharedFile;
  video?: boolean;
};

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)([?#]|$)/i;
const VIDEO_NAME = /\.(mp4|mov|m4v|webm)([?#]|$)/i;

/** What kind of media a file is, from its type or name; null for a document. */
export function mediaKind(file: { name: string; url: string; mime?: string }): "image" | "video" | null {
  const mime = (file.mime ?? "").toLowerCase();
  if ((mime.startsWith("image/") && mime !== "image/svg+xml") || IMAGE_NAME.test(file.name) || (/^https?:\/\//i.test(file.url) && IMAGE_NAME.test(file.url))) return "image";
  if (mime.startsWith("video/") || VIDEO_NAME.test(file.name) || (/^https?:\/\//i.test(file.url) && VIDEO_NAME.test(file.url))) return "video";
  return null;
}

const URL_RE = /https?:\/\/[^\s)>\]]+/g;

/** Pulls links, media (pictures and videos, however they were sent) and documents out of chat rows for the room tabs. */
export function collectShares(messages: { conversationId?: string; body: string; blocks?: MessageBlock[] | null }[]): {
  links: string[];
  media: SharedImage[];
  files: SharedFile[];
} {
  const links = new Set<string>();
  const media: SharedImage[] = [];
  const files: SharedFile[] = [];
  const seenFiles = new Set<string>();
  for (const message of messages) {
    harvest(message.body, links);
    for (const block of message.blocks ?? []) {
      if (block.kind === "text") harvest(block.markdown, links);
      if (block.kind === "image" && (block.url || block.previewUrl)) {
        media.push({ label: block.alt || "Image", url: block.previewUrl || block.url });
      }
      if (block.kind === "file") {
        const key = `${block.name}:${block.url}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        const file: SharedFile = {
          name: block.name,
          url: block.url,
          mime: block.mime,
          conversationId: message.conversationId,
          blobRef: block.blobRef,
        };
        // Pictures and videos belong in Media, even when they were sent as files.
        const kind = mediaKind(file);
        if (kind) media.push({ label: block.name, url: block.url, file, video: kind === "video" });
        else files.push(file);
      }
    }
  }
  return { links: [...links], media, files };
}

function harvest(text: string, links: Set<string>): void {
  for (const match of text.matchAll(URL_RE)) links.add(match[0].replace(/[.,;]+$/, ""));
}
