import { SOCIAL_PLUGINS } from "../social/catalog.js";
import type { McpToolCacheEntry } from "./types.js";

/** Icon is shown when set. Letter and color are the fallback when it is missing or fails to load. */
export type PluginMark = { icon: string | null; letter: string; color: string };

/** A skill copied into the account when this plugin is added. */
export type PluginSkill = { name: string; description: string; body: string };

export type CatalogPlugin = {
  id: string;
  name: string;
  description: string;
  section: string;
  /** A featured plugin the person signs in to through this server. The name is historical: not all are Google's. */
  kind: "google";
  /** Whose sign-in and API it uses. Google plugins share one Google token; the others keep their own. */
  provider: "google" | "instagram" | "tiktok";
  /** For a plugin each person connects with their own developer app: what to ask for and how to get it. */
  app?: { keyLabel: string; secretLabel: string; portal: string; steps: string[] };
  mark: PluginMark;
  skills: PluginSkill[];
  scopes: string[];
  tools: McpToolCacheEntry[];
};

const confirm = " Confirm with the person before creating or changing anything.";

/** Featured plugins this product can actually connect. Other companies' listings are not copied here. */
export const PLUGIN_CATALOG: CatalogPlugin[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Search, read, label, archive, draft, send, and delete email. Sending and deleting wait for your approval.",
    section: "Featured",
    kind: "google",
    provider: "google",
    mark: { icon: "https://www.gstatic.com/images/branding/product/1x/gmail_2020q4_32dp.png", letter: "M", color: "#EA4335" },
    skills: [
      { name: "gmail-search", description: "Look up and read messages in this account.", body: "Use gmail_search and gmail_read. Do not send mail from this skill." },
      { name: "gmail-draft", description: "Prepare a message without sending it.", body: "Use gmail_create_draft. Leave the message as a draft." },
      { name: "gmail-send", description: "Send mail after the person approves.", body: "Use gmail_send only after Auto-review approves that exact message." },
      {
        name: "gmail-tidy",
        description: "Organize mail: labels, read state, archive, delete.",
        body: "Find messages with gmail_search; it returns up to 50 at a time, so follow nextPageToken until it is null before saying how many there are. Use gmail_label to file mail under labels (it creates a missing label) or star it, gmail_mark_read for read state, gmail_archive to take mail out of the inbox, and gmail_delete to move it to Trash. Only touch the messages the person asked about, and report counts from what the tools returned.",
      },
    ],
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    tools: [
      {
        name: "search",
        description:
          "Search this account's Gmail with Gmail search syntax (in:inbox, is:unread, from:, label:, older_than:). Returns up to `limit` messages (default 20, at most 50) with date, sender, subject, unread and labels, an estimated total, and nextPageToken to fetch the next page.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" }, pageToken: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "read",
        description: "Read one Gmail message by id: headers, labels and the plain-text body.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      {
        name: "create_draft",
        description: "Create a Gmail draft. This does not send it." + confirm,
        inputSchema: {
          type: "object",
          properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "send",
        description: "Send an email. Auto-review holds this until the person approves the exact message.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
            draftId: { type: "string" },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "list_labels",
        description: "List this account's Gmail labels.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "label",
        description:
          "Add or remove labels on Gmail messages by id, by label name. A missing label in `add` is created. STARRED and IMPORTANT work too. Trash and Spam are not set here." + confirm,
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
            add: { type: "array", items: { type: "string" } },
            remove: { type: "array", items: { type: "string" } },
          },
          required: ["ids"],
        },
      },
      {
        name: "mark_read",
        description: "Mark Gmail messages read, or unread with read: false.",
        inputSchema: {
          type: "object",
          properties: { ids: { type: "array", items: { type: "string" } }, read: { type: "boolean" } },
          required: ["ids"],
        },
      },
      {
        name: "archive",
        description: "Archive Gmail messages by id: they leave the inbox and stay in All Mail." + confirm,
        inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
      },
      {
        name: "delete",
        description: "Move Gmail messages to Trash by id. Gmail empties Trash after 30 days. Auto-review holds this until the person approves.",
        inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
      },
    ],
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Search events and create events.",
    section: "Featured",
    kind: "google",
    provider: "google",
    mark: { icon: "https://www.gstatic.com/images/branding/product/1x/calendar_2020q4_32dp.png", letter: "31", color: "#4285F4" },
    skills: [
      { name: "calendar-find", description: "Look up events on the primary calendar.", body: "Use google-calendar_search_events." },
      { name: "calendar-schedule", description: "Create an event after the person agrees.", body: "Use google-calendar_create_event only after the person confirms the time." },
    ],
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    tools: [
      {
        name: "search_events",
        description: "Search events on the primary calendar." + confirm,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, timeMin: { type: "string" }, timeMax: { type: "string" } },
        },
      },
      {
        name: "create_event",
        description: "Create an event on the primary calendar." + confirm,
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
          },
          required: ["summary", "start", "end"],
        },
      },
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Search and read files.",
    section: "Featured",
    kind: "google",
    provider: "google",
    mark: { icon: "https://www.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png", letter: "D", color: "#34A853" },
    skills: [
      { name: "drive-search", description: "Find files in this account's Drive.", body: "Use google-drive_search." },
      { name: "drive-read", description: "Read a file the search step found.", body: "Use google-drive_read with the file id from search." },
    ],
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    tools: [
      {
        name: "search",
        description: "Search files in this account's Drive." + confirm,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      {
        name: "read",
        description: "Read one Drive file's name and text when the file is plain text." + confirm,
        inputSchema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
      },
    ],
  },
  ...SOCIAL_PLUGINS,
];

export function catalogPlugin(id: string): CatalogPlugin | undefined {
  return PLUGIN_CATALOG.find((plugin) => plugin.id === id);
}

export function scopesCover(granted: string, required: string[]): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return required.every((scope) => have.has(scope));
}
