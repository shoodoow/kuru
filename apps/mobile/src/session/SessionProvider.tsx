import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { router, usePathname } from "expo-router";
import type { MenuPage, SignedAccount } from "../account/MenuSheet";
import { authCallbackURL } from "../auth-callback-url";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { readFileAsDataUrl } from "../chat/file-web";
import { desktopApp } from "../desk/desktop-app";
import { appInView, askToNotify, setBadge, showNotification } from "../desk/notify-web";
import * as ImagePicker from "expo-image-picker";
import {
  configureAuthCookie,
  contextLine as formatContextLine,
  contextUsageShare,
  createCore,
  type AccountSettings,
  type DefaultModelSetting,
  type InboxStatus,
  type MessageBlock,
  type Proposal,
  type PluginList,
  type ProviderSetting,
  type Reaction,
  type RichMessage,
  type RosterAgent,
  type Routine,
  type ToolApproval,
} from "../api";
import { blocksFromMaybeWidgetText, expandWidgetMarkupBlocks, versionNotice, type AgentMark, type ServerVersionInfo } from "@kuru/shared";
import {
  configureForegroundBanners,
  getPushToken,
  onPushTap,
  onPushWhileOpen,
} from "../push";
import { activeSlot, authClient, authClientFor, forgetSlot, newSlot, rememberAccount, savedAccounts, selectSlot, type SavedAccount } from "../auth";
import { installOAuthReturnHandler } from "../auth-oauth-return";
import * as WebBrowser from "expo-web-browser";
import { coreBaseUrl, defaultCoreUrl, normalizeCoreUrl, saveCoreUrl } from "../core-url";
import { pluginSlug } from "../account/PluginsPage";
import type { Bubble } from "../chat/ChatScreen";
import type { RoomActivityPhase } from "../chat/room-activity";
import { hydrateMarkThumbCache, warmMarkThumbs } from "../ui/DotStage";
import { resolveMarkLook } from "../ui/Mark";
import { isWideLayout } from "../desk/layout";
import { documentPickerOptions } from "../media/documentPickerOptions";
import { cameraPickerOptions, imageLibraryPickerOptions } from "../media/imagePickerOptions";
import type { GroupFace } from "../ui/GroupCluster";
import type { ToastMessage } from "../ui/Toast";

// Asked for on each request, so it is the session of the server in use now.
configureAuthCookie(() => authClient.getCookie());
const core = createCore();

/**
 * Turns one saved row into a bubble, resolving reply quotes and names.
 * Why: shared by full refreshes and live SSE appends so streamed bubbles look
 * identical to reloaded ones. Reactions attach separately (fetched in bulk).
 * Input: row, id lookup, reactions-by-message, roster. Output: one bubble.
 */
function toBubble(
  row: RichMessage,
  byId: Map<string, RichMessage>,
  byMessage: Map<string, Reaction[]>,
  roster: RosterAgent[],
): Bubble {
  const parent = row.replyTo ? byId.get(row.replyTo) : undefined;
  const rawBlocks: MessageBlock[] | null =
    row.kind === "rich" && Array.isArray(row.payload) ? (row.payload as MessageBlock[]) : null;
  const blocks: MessageBlock[] | null = rawBlocks
    ? (expandWidgetMarkupBlocks(rawBlocks) as MessageBlock[])
    : row.body.includes("[widget:")
      ? blocksFromMaybeWidgetText(row.body)
      : null;
  return {
    id: row.id,
    author: row.agentId ? (roster.find((agent) => agent.id === row.agentId)?.name ?? "Agent") : "You",
    agentId: row.agentId,
    mine: row.agentId === null,
    body: row.body,
    sortAt: row.createdAt,
    time: new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    blocks,
    replyTo: row.replyTo ?? null,
    replyPreview: parent?.body.slice(0, 80) ?? null,
    via: row.viaAgentId ? (roster.find((agent) => agent.id === row.viaAgentId)?.name ?? null) : null,
    relay:
      row.relayKind === "from" || row.relayKind === "to"
        ? {
            kind: row.relayKind,
            sourceConversationId: row.sourceConversationId ?? null,
            peers: Array.isArray(row.relayPeers)
              ? row.relayPeers.map((peer) => ({
                  id: String(peer.id),
                  label: String(peer.label ?? roster.find((agent) => agent.id === peer.id)?.label ?? "Bot"),
                }))
              : [],
          }
        : null,
    reactions: byMessage.get(row.id) ?? [],
  };
}

/**
 * Turns saved rich rows into chat bubbles with reply context.
 * Why: thread shows blocks/images/widgets inline plus quoted parents and
 * tapbacks; body stays the fallback for text-only rows.
 * Input: message rows, reactions, roster, by-id lookup. Output: bubbles.
 */
function toBubbles(
  rows: RichMessage[],
  reactions: Reaction[],
  roster: RosterAgent[],
): Bubble[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byMessage = new Map<string, Reaction[]>();
  for (const reaction of reactions) {
    const list = byMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageId, list);
  }
  return rows.map((row) => toBubble(row, byId, byMessage, roster));
}

/** Messages loaded when a chat opens, and per step back through its history. */
const THREAD_PAGE = 60;
/** Messages re-read on each sync of an open chat; older rows stay as loaded. */
const SYNC_PAGE = 30;
/** How often an open chat re-reads the server: quickly while an agent is working, rarely when idle. */
const SYNC_ACTIVE_MS = 2000;
const SYNC_IDLE_MS = 15000;
/** How often the phone asks for pings it has not shown yet (the open chat hears its own at once over the stream). */
const NOTIFICATION_POLL_MS = 10000;
/** How often the inbox list re-reads unread counts and who is working. */
const INBOX_POLL_MS = 4000;
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sortBubbles(bubbles: Bubble[]): Bubble[] {
  return [...bubbles].sort((left, right) => left.sortAt.localeCompare(right.sortAt) || left.id.localeCompare(right.id));
}

export type Attachment = {
  id: string;
  kind: "image" | "file";
  url: string;
  name?: string;
  mime?: string | null;
};

/** What the panel beside the chat shows in a desktop window. */
/** What the panel beside the chat shows in a desktop window; "screen" is the computer filling the window. */
export type SidePanel = "details" | "computer" | "screen";

export type ChatTarget = {
  agent: RosterAgent;
  conversationId: string;
  kind: "direct" | "group";
  title: string;
  subtitle: string;
  memberIds: string[];
};

/** Screens that slide up over whatever is underneath, and are closed before another screen opens. */
const SHEET_ROUTES = new Set(["/account", "/new-room"]);

/** Goes back to the chat list, closing every screen above it. */
function backToInbox(): void {
  if (router.canDismiss()) {
    router.dismissAll();
  }
}

/**
 * Shows the roster, a chat, approvals, a profile, and the live desktop.
 * Input: none. The core URL comes from EXPO_PUBLIC_CORE_URL.
 * Output: the phone screens for those actions.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<SavedAccount[]>(() => savedAccounts());
  // The account whose data is on screen, readable by code that runs between renders.
  const accountIdRef = useRef("");
  const [accountId, setAccountId] = useState("");
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [providers, setProviders] = useState<ProviderSetting[]>([]);
  const [plugins, setPlugins] = useState<PluginList | null>(null);
  const [menu, setMenu] = useState<MenuPage | null>(null);
  const [afterSignup, setAfterSignup] = useState(false);
  const [draft, setDraft] = useState("");
  // Unsent text per chat, so leaving a chat and coming back keeps what was typed.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftsRef = useRef(new Map<string, string>());
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [sending, setSending] = useState(false);
  const [roomActivity, setRoomActivity] = useState<RoomActivityPhase | null>(null);
  // Why: the open chat must keep merging server rows after send() returns.
  // A one-shot watcher stopped before a late reply, so it only appeared on reopen.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const expectReply = useRef(false);
  const turnActiveRef = useRef(false);
  /** The chat on screen, for code that runs outside its render. */
  const openRoomRef = useRef("");
  /** Re-reads the inbox status now, so a finished turn does not keep showing as working. */
  const refreshInboxRef = useRef<() => void>(() => {});
  const turnIsGroupRef = useRef(false);
  const turnAgentNameRef = useRef("");
  const [replyTo, setReplyTo] = useState<Bubble | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  /** Raises the short banner: green tick for done, red mark for failed. */
  const notify = useCallback((text: string, tone: ToastMessage["tone"] = "success"): void => {
    toastId.current += 1;
    setToast({ id: toastId.current, at: Date.now(), text, tone });
  }, []);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [toolApprovals, setToolApprovals] = useState<ToolApproval[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [groupFeed, setGroupFeed] = useState<(Bubble & { conversationId?: string })[]>([]);
  const [profileFeed, setProfileFeed] = useState<(Bubble & { conversationId?: string })[]>([]);
  const [profile, setProfile] = useState<RosterAgent | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [contextRing, setContextRing] = useState<{ share: number; hint: string } | null>(null);
  const [groups, setGroups] = useState<{ id: string; title: string; memberCount: number; members: GroupFace[] }[]>([]);
  // Last opened chat, so the desktop back-button returns to the right title.
  const [lastChat, setLastChat] = useState<ChatTarget | null>(null);
  const lastChatRef = useRef(lastChat);
  lastChatRef.current = lastChat;
  const [desktopAgent, setDesktopAgent] = useState<RosterAgent | null>(null);
  // Desktop window only: what the panel beside the chat shows, or null when it is closed.
  const [sidePanel, setSidePanel] = useState<SidePanel | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [serverUrl, setServerUrl] = useState(() => coreBaseUrl());
  // Set when this app and the server it talks to are too far apart in version.
  const [versionNote, setVersionNote] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setVersionNote(null);
    // Best effort: a server that cannot be reached says nothing about versions.
    fetch(`${serverUrl}/health`, { credentials: "omit" })
      .then((response) => (response.ok ? (response.json() as Promise<ServerVersionInfo>) : null))
      .then((info) => {
        if (!stale && info) setVersionNote(versionNotice(info));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [serverUrl]);
  // False until the saved sign-in has been checked, so a signed-in person never sees the welcome page flash by.
  const [restored, setRestored] = useState(false);
  const [inbox, setInbox] = useState<InboxStatus | null>(null);
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  // Threads and member lists already seen, so a chat opens on what was last
  // on screen instead of waiting for the server before it even appears.
  const threadCacheRef = useRef(new Map<string, Bubble[]>());
  const membersCacheRef = useRef(new Map<string, string[]>());
  /** The chat being opened; a slower, older open must not overwrite it. */
  const enteringRef = useRef("");
  // True while a chat that has never been seen is loading its first page.
  const [threadLoading, setThreadLoading] = useState(false);
  const [autoReview, setAutoReview] = useState(true);
  const [defaultModel, setDefaultModel] = useState<DefaultModelSetting | null>(null);
  const [cheapModel, setCheapModel] = useState<DefaultModelSetting | null>(null);
  // True for a signed-in account that has no default agent yet: the inbox shows the setup guide.
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [autoTimeZone, setAutoTimeZone] = useState(true);
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  /**
   * Closes the account or new-chat sheet if one is on top, and nothing else.
   * Why: this used to close every screen above the chat list. Opening the
   * desktop or the approvals from a chat therefore threw the chat away, and
   * Back landed on the list instead of the chat.
   */
  function closeSheet(): void {
    if (SHEET_ROUTES.has(pathnameRef.current) && router.canDismiss()) {
      router.dismiss();
    }
  }
  const account = accounts.find((row) => row.id === accountId) ?? null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * Shows a request error on the screen.
   * Input: the thrown value.
   * Output: nothing. The note becomes the error message.
   */
  const show = useCallback((error: unknown): void => {
    const text = error instanceof Error ? error.message : "The request failed.";
    // The red line belongs to the chat list. While a sheet covers that list
    // the line would sit hidden underneath it, so only the banner speaks.
    if (pathnameRef.current === "/") setNote(text);
    notify(text, "error");
  }, [notify]);

  /**
   * Loads the Google session and the roster for that account id.
   * Input: none. It reads the session stored on the phone.
   * Output: nothing. The inbox shows the signed-in account.
   */
  async function refreshSession(): Promise<void> {
    const session = await authClient.getSession();
    const signed = session.data?.user;
    const accountIdFromSession = signed && "accountId" in signed ? String(signed.accountId ?? "") : "";
    if (!signed || !accountIdFromSession) {
      // The server answered and knows no session for this slot: the sign-in
      // has expired or was ended. A request that failed says nothing either way.
      if (!session.error && savedAccounts().some((row) => row.slot === activeSlot())) {
        forgetSlot(activeSlot());
        setAccounts(savedAccounts());
      }
      return;
    }
    const replaced = rememberAccount({
      slot: activeSlot(),
      server: coreBaseUrl(),
      id: accountIdFromSession,
      name: signed.name,
      email: signed.email,
      image: signed.image ?? null,
    });
    // The same account signed in a second time: the older sign-in is ended,
    // unless it is this very session kept twice, which ending would sign out here too.
    const current = authClient.getCookie();
    for (const old of replaced) {
      const client = authClientFor(old.server, old.slot);
      if (client.getCookie() !== current) void client.signOut().catch(() => {});
    }
    setAccounts(savedAccounts());
    // Another account's chats and keys must not show under this one.
    if (accountIdRef.current && accountIdRef.current !== accountIdFromSession) clearAccountData();
    accountIdRef.current = accountIdFromSession;
    setAccountId(accountIdFromSession);
    const [roster, configured, settings] = await Promise.all([
      core.listAgents(accountIdFromSession),
      core.listProviders(accountIdFromSession),
      core.getSettings(accountIdFromSession).catch((): AccountSettings => ({ autoReview: true, timezone: "" })),
    ]);
    setAgents(roster);
    setProviders(configured);
    setAutoReview(settings.autoReview);
    setDefaultModel(settings.defaultModel ?? null);
    setCheapModel(settings.cheapModel ?? null);
    setSetupNeeded(!roster.some((agent) => agent.kind === "support"));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) {
      await core.rememberTimezone(accountIdFromSession, zone).catch(() => {});
    }
    setMenu(null);
    // Closing a sheet already lands on the chat list. Replacing the list in
    // the same moment, while the sheet was still sliding away, left a blank
    // screen after an account switch. The list is replaced only when some
    // other full screen is up and there is nothing to close (sign-in return).
    // On a cold start the list is already showing and is left alone.
    if (router.canDismiss()) {
      router.dismissAll();
    } else if (pathnameRef.current !== "/") {
      router.replace("/");
    }
    setNote("");
    await loadGroups(accountIdFromSession, roster);
    // Best-effort push registration + badge: no EAS projectId, denied
    // permission, or network failure all degrade to SSE/polling silently.
    try {
      const push = await getPushToken();
      if (push) {
        await core.registerDevice(accountIdFromSession, { expoPushToken: push.token, platform: push.platform, installId: push.installId });
      }
      const pending = await core.listNotifications(accountIdFromSession).catch(() => []);
      setPendingCount(pending.length);
    } catch {
      // Push unavailable; the thread still streams when open.
    }
  }

  /** Drops everything loaded for one account, so nothing of it shows under another. */
  function clearAccountData(): void {
    setAgents([]);
    setProviders([]);
    setPlugins(null);
    setGroups([]);
    setInbox(null);
    setMessages([]);
    setConversationId("");
    setLastChat(null);
    setProfile(null);
    setDesktopAgent(null);
    setProposals([]);
    setToolApprovals([]);
    setRoutines([]);
    setPendingCount(0);
    setDefaultModel(null);
    setCheapModel(null);
    setSetupNeeded(false);
    setContextRing(null);
    setDraft("");
    draftsRef.current.clear();
    threadCacheRef.current.clear();
    membersCacheRef.current.clear();
    enteringRef.current = "";
    setThreadLoading(false);
    setNote("");
  }

  /**
   * Leaves the account in use: clears what was loaded for it and returns to the
   * welcome page.
   * Why: sign-out used to clear the account id and the roster only. Chats,
   * provider keys, plugins and pending approvals stayed in memory.
   */
  function forgetAccount(): void {
    clearAccountData();
    accountIdRef.current = "";
    setAccounts(savedAccounts());
    setAccountId("");
    setMenu(null);
    backToInbox();
  }

  /**
   * After leaving an account, moves to another one still signed in on this
   * phone, or to the welcome page when there is none.
   */
  async function fallBack(): Promise<void> {
    accountIdRef.current = "";
    clearAccountData();
    // A slot whose sign-in has expired is dropped by the refresh, so this ends.
    for (let tries = 0; tries < 6 && savedAccounts().length > 0; tries += 1) {
      const next = savedAccounts()[0]!;
      saveCoreUrl(next.server);
      setServerUrl(coreBaseUrl());
      selectSlot(next.slot);
      await refreshSession().catch(() => {});
      if (accountIdRef.current) return;
      // Could not be checked (offline): stop here and keep the list as it is.
      if (savedAccounts().some((row) => row.slot === next.slot)) break;
    }
    forgetAccount();
  }

  /**
   * Makes another account on this phone the one in use.
   * Why: each account keeps its own session, so this needs no trip to Google.
   * Input: the account's slot. Output: nothing. Throws when that sign-in has expired.
   */
  async function switchAccount(slot: string): Promise<void> {
    const entry = savedAccounts().find((row) => row.slot === slot);
    if (!entry || (slot === activeSlot() && entry.server === coreBaseUrl() && accountIdRef.current === entry.id)) return;
    saveCoreUrl(entry.server);
    setServerUrl(coreBaseUrl());
    selectSlot(slot);
    try {
      await refreshSession();
    } catch (error) {
      // The account changed but its chats did not load. Say so; an empty list
      // with no word of why reads as a broken app.
      throw new Error(`Switched to ${entry.email}, but its chats did not load: ${error instanceof Error ? error.message : "the server did not answer"}. Pull down to try again.`);
    }
    if (accountIdRef.current !== entry.id) {
      await fallBack();
      throw new Error(`The sign-in for ${entry.email} has expired. Add the account again.`);
    }
  }

  /**
   * Signs in one more account and keeps the others signed in.
   * The new sign-in goes to a slot of its own; if it is cancelled, the app
   * stays on the account it was on.
   */
  async function addAccount(): Promise<void> {
    if (savedAccounts().length >= 5) {
      throw new Error("Five accounts are signed in on this phone. Sign out of one to add another.");
    }
    const previous = activeSlot();
    selectSlot(newSlot());
    try {
      await signInWithGoogle();
    } catch (error) {
      selectSlot(previous);
      throw error;
    }
  }

  /** Ends the session of the account in use, on the server and on this phone. */
  async function signOut(): Promise<void> {
    // The phone is signed out even when the server cannot be told.
    await authClient.signOut().catch(() => {});
    forgetSlot(activeSlot());
    await fallBack();
  }

  /**
   * Deletes the signed-in account on the server, with everything it owns.
   * Why: this used to take the account off a list on the screen and delete
   * nothing, so the person was signed straight back in on the next start.
   * Output: nothing. Throws when the server did not delete it, and the person stays signed in.
   */
  async function deleteAccount(): Promise<void> {
    const id = accountId.trim();
    if (!id) return;
    await core.deleteAccount(id);
    // The server has already dropped the session; this clears the copy kept on the phone.
    await authClient.signOut().catch(() => {});
    forgetSlot(activeSlot());
    await fallBack();
  }

  /**
   * Points the app at another server.
   * Why: people run their own server, so the address cannot be fixed in the
   * build. The new address is checked before it is kept, and whoever is
   * signed in is signed out of this phone's view first, because accounts
   * belong to a server.
   * Input: what the person typed, or "" for the build's own server.
   * Output: nothing. Throws a sentence the screen can show when it will not work.
   */
  async function changeServer(typed: string): Promise<void> {
    const next = typed.trim() ? normalizeCoreUrl(typed) : defaultCoreUrl();
    if (!next) throw new Error("That is not a web address. Try something like https://agents.example.com.");
    if (next === coreBaseUrl()) return;
    try {
      const probe = await fetch(`${next}/api/auth/get-session`, { credentials: "omit" });
      if (!probe.ok) throw new Error(`status ${probe.status}`);
    } catch (error) {
      throw new Error(
        `No server answered at ${next}${error instanceof Error && error.message.startsWith("status") ? ` (${error.message})` : ""}. Check the address${next.startsWith("http://") ? "; this app may only allow https" : ""}.`,
      );
    }
    saveCoreUrl(next);
    setServerUrl(coreBaseUrl());
    // An account already signed in on that server is used; otherwise a fresh slot waits for a sign-in.
    selectSlot(savedAccounts().find((row) => row.server === coreBaseUrl())?.slot ?? newSlot());
    clearAccountData();
    accountIdRef.current = "";
    setAccountId("");
    await refreshSession().catch(() => {});
  }

  /**
   * Signs in with Google and keeps the account id the core creates.
   * Input: none. Google returns the session.
   * Output: nothing. Later chats and groups use that account id.
   */
  async function signInWithGoogle(): Promise<void> {
    const base = coreBaseUrl();
    try {
      const probe = await fetch(`${base}/api/auth/get-session`, { credentials: "omit" });
      if (!probe.ok) {
        throw new Error(`Core auth returned ${probe.status}.`);
      }
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.includes("Core auth")
          ? error.message
          : `Cannot reach the server at ${base}. Check the server address on this screen.`,
      );
    }
    // The desktop app: Google refuses to sign in inside an app window, so the
    // sign-in runs in the person's own browser and the app reloads signed in.
    const desktop = desktopApp();
    if (desktop?.signIn) {
      await desktop.signIn();
      return;
    }
    const callbackURL = authCallbackURL();
    try {
      const result = await authClient.signIn.social({ provider: "google", callbackURL });
      if (result.error) {
        throw new Error(result.error.message ?? "Google sign in failed.");
      }
    } finally {
      if (Platform.OS !== "web") {
        try {
          await WebBrowser.dismissBrowser();
          await WebBrowser.dismissAuthSession();
        } catch {
          /* custom tab already closed */
        }
      }
    }
    await refreshSession();
    const session = await authClient.getSession();
    if (!session.data?.session) {
      throw new Error(
        "Google sign-in did not finish (browser closed or redirect failed). Confirm Google Console redirect URI https://api.example.com/api/auth/callback/google and try again.",
      );
    }
    if (afterSignup) {
      setAfterSignup(false);
      router.push("/new-room");
    }
  }

  useEffect(() => {
    hydrateMarkThumbCache();
    void refreshSession()
      .catch(show)
      // The account last used has expired, but another is still signed in.
      .then(() => (accountIdRef.current || savedAccounts().length === 0 ? undefined : fallBack()))
      .finally(() => setRestored(true));
  }, [show]);

  useEffect(() => {
    const timer = setTimeout(() => {
      warmMarkThumbs(agents.map((row) => resolveMarkLook(row)), { prioritize: true });
    }, 120);
    return () => clearTimeout(timer);
  }, [agents]);

  useEffect(() => {
    return installOAuthReturnHandler(() => {
      void refreshSession().catch(show);
    });
  }, [show]);

  useEffect(() => {
    const id = accountId.trim();
    if (!id) return;
    let stopped = false;
    const shown = new Set<string>();
    const web = process.env.EXPO_OS === "web";
    if (web && notifications) askToNotify();
    const pull = async (): Promise<void> => {
      const pending = await core.listNotifications(id).catch(() => []);
      if (stopped) return;
      setPendingCount(pending.length);
      for (const note of pending) {
        if (shown.has(note.id)) continue;
        shown.add(note.id);
        // A computer gets no push, so the web and desktop app show the system
        // notification instead, unless the person is already reading that chat.
        // Old ones waiting from before the app opened are not shown.
        const fresh = Date.now() - Date.parse(note.createdAt) < 2 * 60_000;
        const watching = appInView() && openRoomRef.current === note.conversationId;
        if (web && notifications && fresh && !watching) {
          showNotification({ title: note.title, body: note.body, tag: note.conversationId }, () => setTappedRoom(note.conversationId));
        }
        // On a phone the app is open: the chat list's unread counts already show it.
        await core.ackNotification(id, note.id).catch(() => {});
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), NOTIFICATION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [accountId, notifications]);

  /**
   * Keeps the inbox list's unread counts and working marks current.
   * Why: without them the person had to open each chat to see whether an agent
   * had answered or was still busy. The open chat is read as it is watched,
   * so it never counts as unread here.
   */
  useEffect(() => {
    const id = accountId.trim();
    if (!id) {
      setInbox(null);
      return;
    }
    let stopped = false;
    const pull = async (): Promise<void> => {
      const status = await core.inboxStatus(id).catch(() => null);
      if (stopped || !status) return;
      const open = openRoomRef.current;
      const next = { ...status, rooms: status.rooms.map((room) => (room.id === open ? { ...room, unread: 0 } : room)) };
      // Nothing new since the last poll: keep the old object, so no screen redraws.
      setInbox((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
      // The desktop app shows the unread total on its Dock or taskbar icon.
      setBadge(next.rooms.reduce((total, room) => total + room.unread, 0));
    };
    void pull();
    refreshInboxRef.current = () => void pull();
    const timer = setInterval(() => void pull(), INBOX_POLL_MS);
    return () => {
      stopped = true;
      refreshInboxRef.current = () => {};
      clearInterval(timer);
    };
  }, [accountId]);

  // A push that lands while the app is open shows nothing: the chat list's
  // unread counts already say a reply came, so the list is refreshed instead.
  useEffect(() => onPushWhileOpen(() => refreshInboxRef.current()), []);

  useEffect(() => {
    configureForegroundBanners();
    return onPushTap((data) => {
      // A push tap carries the exact room: open it instead of the inbox. It is
      // held until the account and its agents are loaded, since a tap that
      // launched the app arrives before they are.
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
      if (!conversationId) return;
      setTappedRoom(conversationId);
    });
  }, [show]);

  const [tappedRoom, setTappedRoom] = useState<string | null>(null);
  useEffect(() => {
    if (!tappedRoom || !accountId.trim() || agents.length === 0) return;
    const roomId = tappedRoom;
    setTappedRoom(null);
    void openGroup(roomId).catch(show);
    // openGroup reads the current account through refs; the room and the loaded roster are what matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tappedRoom, accountId, agents.length]);

  /**
   * Hires an agent and opens a direct chat on the signed-in account.
   * Why: role + job ship with the hire so the agent starts with identity, not a blob.
   * Input: the agent name, role, and job from the new-room sheet.
   * Output: nothing. The chat screen opens for that agent.
   */
  async function createChat(name: string, look?: AgentMark): Promise<void> {
    if (!accountId.trim()) {
      throw new Error("Sign in first, then create a chat.");
    }
    // The new agent starts on the account's default model, or failing that on
    // the one the default agent already runs on.
    const model = defaultModel ?? agents.find((agent) => agent.kind === "support") ?? agents[0];
    if (!model) {
      throw new Error("Choose a default model in the account menu first.");
    }
    const hired = await core.hireAgent(accountId, { name, provider: model.provider, modelId: model.modelId, look });
    const room = await core.openChat(accountId, hired);
    // The agent opens the chat itself, by asking what it is here to help with;
    // if that fails the chat just starts empty.
    void core.sayHello(accountId, room.id).catch(() => {});
    const rows = await core.listAgents(accountId);
    const fresh = rows.find((row) => row.id === hired.id) ?? hired;
    setAgents(rows);
    await enterRoom({ id: room.id, kind: "direct", title: fresh.name, ownerAgentId: fresh.id }, rows);
    await loadGroups(accountId, rows);
  }

  /**
   * Opens the default agent's chat and asks it, as the person, for a new agent.
   * Why: opening the chat alone left the person to work out what to type.
   * Input: the default agent and the name typed on the form, if any.
   */
  async function askForAgent(support: RosterAgent, name: string): Promise<void> {
    await openAgent(support);
    const rooms = await core.listConversations(accountId.trim());
    const room = rooms.find((row) => row.kind === "direct" && row.ownerAgentId === support.id);
    if (!room) return;
    await sendText(room.id, name ? `I'd like to set up a new agent called ${name}.` : "I'd like to set up a new agent.");
  }

  /**
   * Opens a group for the chosen agents on the signed-in account.
   * Input: the group title and the member ids.
   * Output: nothing. The chat screen opens on that group.
   */
  async function createGroup(title: string, agentIds: string[]): Promise<void> {
    if (!accountId.trim()) {
      throw new Error("Sign in first, then create a group.");
    }
    const room = await core.createGroup(accountId, title, agentIds);
    const rows = await core.listAgents(accountId);
    setAgents(rows);
    await enterRoom({ id: room.id, kind: "group", title, ownerAgentId: agentIds[0]! }, rows);
    await loadGroups(accountId, rows);
  }

  /**
   * Loads one thread as bubbles without touching state.
   * Why: shared by full refreshes and the native poll loop so both merge the
   * same way. Input: room id + roster. Output: fresh bubbles.
   */
  async function loadThread(roomId: string, roster: RosterAgent[]): Promise<Bubble[]> {
    const [history, taps] = await Promise.all([
      core.listMessages(accountId.trim(), roomId, { limit: THREAD_PAGE }),
      core.listReactions(accountId.trim(), roomId),
    ]);
    olderRef.current = { roomId, more: history.length >= THREAD_PAGE, loading: false };
    return toBubbles(history, taps, roster);
  }

  // Whether the open chat has history above what is loaded.
  const olderRef = useRef<{ roomId: string; more: boolean; loading: boolean }>({ roomId: "", more: false, loading: false });

  /**
   * Loads the page of messages above the oldest one on screen.
   * Why: a chat opens on its recent messages only; the rest arrives as the
   * person scrolls up, so a long thread costs nothing until it is read.
   * Input: none (uses the open chat). Output: nothing.
   */
  async function loadOlderMessages(): Promise<void> {
    const roomId = conversationId;
    const state = olderRef.current;
    if (!roomId || state.roomId !== roomId || !state.more || state.loading) return;
    const oldest = messagesRef.current.find((bubble) => SERVER_ID.test(bubble.id));
    if (!oldest) return;
    state.loading = true;
    try {
      const [history, taps] = await Promise.all([
        core.listMessages(accountId.trim(), roomId, { limit: THREAD_PAGE, before: oldest.id }),
        core.listReactions(accountId.trim(), roomId),
      ]);
      if (olderRef.current.roomId !== roomId) return;
      olderRef.current.more = history.length >= THREAD_PAGE;
      mergeThread(toBubbles(history, taps, agentsRef.current));
    } finally {
      state.loading = false;
    }
  }

  /**
   * Merges server bubbles over the current thread.
   * Why: MERGE, never replace — streamed/polled bubbles arrive before later
   * refreshes, and replacing would wipe them (the old vanishing glitch).
   * Server rows win on id conflicts; local-only rows (pending, fresh agent
   * bubbles) are kept. Input: fresh server bubbles. Output: nothing.
   */
  function beginTurn(isGroup: boolean, agentName: string): void {
    turnActiveRef.current = true;
    turnIsGroupRef.current = isGroup;
    turnAgentNameRef.current = agentName;
    setRoomActivity("thinking");
  }

  function endTurn(conversationId?: string, opts?: { refreshContext?: boolean }): void {
    if (!turnActiveRef.current) return;
    turnActiveRef.current = false;
    setRoomActivity(null);
    refreshInboxRef.current();
    if (opts?.refreshContext && expectReply.current && conversationId) {
      expectReply.current = false;
      void loadContextLine(conversationId);
    }
  }

  function noteAgentReply(): void {
    if (!turnActiveRef.current) return;
    setRoomActivity(turnIsGroupRef.current ? "teammates" : "working");
  }

  function turnMetaFromScreen(): { isGroup: boolean; agentName: string } {
    const chat = lastChatRef.current;
    if (!chat) {
      return { isGroup: false, agentName: "Agent" };
    }
    return { isGroup: chat.kind === "group", agentName: chat.agent.name };
  }

  // What each bubble on screen looked like as text, so a poll can tell "same
  // as before" without comparing field by field.
  const bubblePrints = useRef(new WeakMap<Bubble, string>());

  function mergeThread(fresh: Bubble[]): void {
    setMessages((current) => {
      const prints = bubblePrints.current;
      const printOf = (bubble: Bubble): string => {
        let print = prints.get(bubble);
        if (print === undefined) {
          print = JSON.stringify(bubble);
          prints.set(bubble, print);
        }
        return print;
      };
      const before = new Map(current.map((bubble) => [bubble.id, bubble]));
      const byId = new Set(fresh.map((bubble) => bubble.id));
      // The open chat re-reads its recent messages often. An unchanged row keeps its old object,
      // and an unchanged thread keeps the old array, so React skips the
      // render entirely instead of redrawing every bubble each tick.
      const merged = fresh.map((bubble) => {
        const old = before.get(bubble.id);
        return old && printOf(old) === printOf(bubble) ? old : bubble;
      });
      for (const bubble of current) {
        if (!byId.has(bubble.id)) {
          merged.push(bubble);
        }
      }
      const next = sortBubbles(merged);
      const same = next.length === current.length && next.every((bubble, index) => bubble === current[index]);
      return same ? current : next;
    });
  }

  /**
   * Reloads one thread with messages + reactions, merging into current state.
   * Input: room id + roster. Output: nothing.
   */
  async function refreshThread(roomId: string, roster: RosterAgent[]): Promise<void> {
    mergeThread(await loadThread(roomId, roster));
  }

  const liveRoomId = conversationId;
  openRoomRef.current = conversationId;

  // Remembers the open thread's latest page for the next time it is opened.
  useEffect(() => {
    // Not while the first page is still loading: an empty list is not the thread.
    if (!conversationId || threadLoading) return;
    const cache = threadCacheRef.current;
    cache.delete(conversationId);
    cache.set(conversationId, messages.slice(-THREAD_PAGE));
    if (cache.size > 12) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }, [conversationId, messages, threadLoading]);

  /**
   * Keeps the open chat matched to the server while the room stays on screen.
   * Why: agent bubbles commit as the turn runs; polling merges them in true
   * createdAt order so a slow reply never jumps above newer user messages.
   * Input: the open room id. Output: nothing. Stops on leave.
   */
  useEffect(() => {
    if (!liveRoomId) return;
    const account = accountId.trim();
    if (!account) return;
    let stopped = false;
    const known = new Set(messagesRef.current.map((bubble) => bubble.id));
    const pull = async (): Promise<void> => {
      try {
        const [history, taps] = await Promise.all([
          core.listMessages(account, liveRoomId, { limit: SYNC_PAGE }),
          core.listReactions(account, liveRoomId),
        ]);
        if (stopped) return;
        const fresh = toBubbles(history, taps, agentsRef.current);
        for (const bubble of fresh) {
          if (turnActiveRef.current && !bubble.mine && !known.has(bubble.id)) {
            noteAgentReply();
          }
          known.add(bubble.id);
        }
        mergeThread(fresh);
        // Whatever is on screen has been seen.
        void core.markRead(account, liveRoomId).catch(() => {});
        setInbox((current) =>
          current && current.rooms.some((room) => room.id === liveRoomId && room.unread > 0)
            ? { ...current, rooms: current.rooms.map((room) => (room.id === liveRoomId ? { ...room, unread: 0 } : room)) }
            : current,
        );
        if (turnActiveRef.current) {
          try {
            const info = await core.chatContext(account, liveRoomId);
            const latest = info.usage.lastRuns[0];
            if (!latest || latest.status !== "running") {
              endTurn(liveRoomId, { refreshContext: true });
            }
          } catch {
            // Best-effort when the stream is unavailable.
          }
        }
      } catch {
        // A missed tick retries. The thread on screen stays as it is.
      }
    };
    // The stream below asks for a sync the moment anything happens, so this
    // loop is only the safety net: quick while a turn runs, slow when idle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      await pull();
      if (stopped) return;
      timer = setTimeout(() => void loop(), turnActiveRef.current ? SYNC_ACTIVE_MS : SYNC_IDLE_MS);
    };
    void loop();
    const unsubscribe = core.subscribeMessages(account, liveRoomId, (event) => {
      if (event.message || event.reaction || event.type === "done" || event.type === "run" || event.type === "error") {
        void pull();
      }
      if (event.type === "message" && event.message?.agentId && turnActiveRef.current) {
        noteAgentReply();
      }
      if (event.type === "run" && event.run?.status && event.run.status !== "running") {
        endTurn(liveRoomId, { refreshContext: true });
      }
      if (event.type === "done") {
        endTurn(liveRoomId, { refreshContext: true });
      }
      if (event.type === "error") {
        expectReply.current = false;
        endTurn();
        show(new Error(event.error ?? "The turn failed."));
      } else if (event.type === "notify" && event.notification) {
        void core
          .listNotifications(account)
          .then((pending) => setPendingCount(pending.length))
          .catch(() => {});
        // No note: the open chat already shows what arrived.
      }
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [liveRoomId, accountId]);

  /**
   * Loads per-chat context + usage for the header line. Best-effort: a failure
   * hides the line instead of blocking the chat.
   * Input: room id. Output: nothing. Sets the header line.
   */
  async function loadContextLine(roomId: string): Promise<void> {
    try {
      const info = await core.chatContext(accountId.trim(), roomId);
      setContextRing({ share: contextUsageShare(info), hint: formatContextLine(info) });
    } catch {
      setContextRing(null);
    }
  }

  /**
   * Enters any room — direct or group — with the right header.
   * Why: one shared path so created, reopened, and direct rooms all show the
   * correct title (group title, never a disguised 1:1) plus member names.
   * Input: room record + roster. Output: nothing. Chat screen opens on it.
   */
  async function enterRoom(
    room: { id: string; kind: string; title: string; ownerAgentId: string },
    roster: RosterAgent[],
  ): Promise<void> {
    const id = accountId.trim();
    const owner = roster.find((row) => row.id === room.ownerAgentId);
    if (!owner) {
      throw new Error("The new agent did not appear in the roster. Try again in a few seconds.");
    }
    const kind = room.kind === "group" ? ("group" as const) : ("direct" as const);
    const target = (memberIds: string[]): ChatTarget => ({
      agent: owner,
      conversationId: room.id,
      kind,
      title: kind === "group" ? room.title : owner.name,
      subtitle:
        kind === "group"
          ? memberIds
              .map((memberId) => roster.find((row) => row.id === memberId)?.name ?? "Agent")
              .join(", ")
              .slice(0, 60)
          : "",
      memberIds,
    });

    // Show the chat at once, on whatever was last seen of it. Waiting for the
    // server first left the list frozen under the finger for a second or more.
    const cached = threadCacheRef.current.get(room.id);
    const leaving = lastChatRef.current?.conversationId;
    if (leaving) draftsRef.current.set(leaving, draftRef.current);
    enteringRef.current = room.id;
    setAgents(roster);
    setConversationId(room.id);
    setLastChat(target(membersCacheRef.current.get(room.id) ?? [owner.id]));
    setMessages(cached ?? []);
    setThreadLoading(!cached);
    setContextRing(null);
    setDraft(draftsRef.current.get(room.id) ?? "");
    setReplyTo(null);
    setAttachments([]);
    setNote("");
    // Already looking at this chat (a push for the open room): leave the screen be.
    if (pathnameRef.current !== `/chat/${room.id}`) {
      // One chat is open at a time, so opening one replaces whatever was above the list.
      backToInbox();
      router.push(`/chat/${room.id}`);
    }
    void loadContextLine(room.id);

    try {
      const [memberRows, history, taps] = await Promise.all([
        core.listMembers(id, room.id).catch(() => [{ agentId: owner.id }]),
        core.listMessages(id, room.id, { limit: THREAD_PAGE }),
        core.listReactions(id, room.id),
      ]);
      // Another chat was opened, or this one closed, while it loaded.
      if (enteringRef.current !== room.id) return;
      const memberIds = memberRows.map((member) => member.agentId);
      membersCacheRef.current.set(room.id, memberIds);
      olderRef.current = { roomId: room.id, more: history.length >= THREAD_PAGE, loading: false };
      setLastChat((current) => (current?.conversationId === room.id ? target(memberIds) : current));
      mergeThread(toBubbles(history, taps, roster));
    } catch (error) {
      // The chat is already on screen, so the reason goes on its own error line.
      if (enteringRef.current === room.id) setNote(error instanceof Error ? error.message : "The chat did not load.");
      throw error;
    } finally {
      if (enteringRef.current === room.id) setThreadLoading(false);
    }
  }

  /**
   * Loads group rooms for the inbox section.
   * Why: groups previously vanished after creation — the inbox listed agents
   * only. Counts come from one members call per group (few groups per user).
   * Input: account id + roster (unused, kept for symmetry). Output: nothing.
   */
  async function loadGroups(id: string, roster: RosterAgent[]): Promise<void> {
    const rooms = await core.listConversations(id).catch(() => []);
    const groups = rooms.filter((room) => room.kind === "group");
    const withCounts = await Promise.all(
      groups.map(async (group) => {
        const members = await core.listMembers(id, group.id).catch(() => []);
        return {
          id: group.id,
          title: group.title,
          memberCount: members.length,
          members: members.map((member) => {
            const agent = roster.find((row) => row.id === member.agentId);
            return {
              id: member.agentId,
              markShape: agent?.markShape,
              markColor: agent?.markColor,
              markMaterial: agent?.markMaterial,
              markStyle: agent?.markStyle,
              markGender: agent?.markGender,
              avatarUrl: agent?.avatarUrl,
            };
          }),
        };
      }),
    );
    setGroups(withCounts);
  }

  /**
   * Opens a direct chat with one agent and subscribes to live turns.
   * Input: the agent from the roster.
   * Output: nothing. The conversation screen is shown and streams.
   */
  async function openAgent(agent: RosterAgent): Promise<void> {
    const id = accountId.trim();
    // The chat list already knows this agent's room: open it now and bring
    // the roster up to date behind it.
    const known = inboxRef.current?.rooms.find((room) => room.kind === "direct" && room.ownerAgentId === agent.id);
    if (known) {
      const roster = agentsRef.current.some((row) => row.id === agent.id) ? agentsRef.current : [...agentsRef.current, agent];
      void core
        .listAgents(id)
        .then((rows) => {
          if (accountIdRef.current === id) setAgents(rows);
        })
        .catch(() => {});
      await enterRoom({ id: known.id, kind: "direct", title: agent.name, ownerAgentId: agent.id }, roster);
      return;
    }
    const rooms = await core.listConversations(id);
    const existing = rooms.find((room) => room.kind === "direct" && room.ownerAgentId === agent.id);
    const rows = await core.listAgents(id);
    const fresh = rows.find((row) => row.id === agent.id) ?? agent;
    setAgents(rows);
    if (existing) {
      await enterRoom(existing, rows);
      return;
    }
    const room = await core.openChat(id, agent);
    await enterRoom({ id: room.id, kind: "direct", title: fresh.name, ownerAgentId: fresh.id }, rows);
  }

  /**
   * Reopens a group from the inbox list.
   * Input: the group conversation id. Output: nothing. Chat opens on it.
   */
  async function openGroup(roomId: string): Promise<void> {
    const id = accountId.trim();
    // A group the list already shows opens at once, like a direct chat.
    const listed = groupsRef.current.find((group) => group.id === roomId);
    const known = inboxRef.current?.rooms.find((room) => room.id === roomId && room.kind === "group");
    if (listed && known && agentsRef.current.some((row) => row.id === known.ownerAgentId)) {
      await enterRoom({ id: roomId, kind: "group", title: listed.title, ownerAgentId: known.ownerAgentId }, agentsRef.current);
      return;
    }
    const [rooms, rows] = await Promise.all([core.listConversations(id), core.listAgents(id)]);
    const room = rooms.find((row) => row.id === roomId);
    if (!room) {
      throw new Error("That group no longer exists. Pull down on Chats to refresh.");
    }
    setAgents(rows);
    await enterRoom(room, rows);
  }

  /**
   * Sends composer text and/or attachments via 202 background turn.
   * Why: POST now returns the saved user row synchronously, so the optimistic
   * bubble is swapped for the confirmed id instead of being wiped by the
   * safety refresh — a sent message can never vanish. Agent bubbles stream in
   * live via SSE; done/run/error ends the activity bar with a reconciling refresh.
   * Input: the open chat. Reads draft, attachments, reply target. Output: nothing.
   */
  async function send(conversationId: string): Promise<void> {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || sending) {
      return;
    }
    const blocks: MessageBlock[] = [];
    if (body) {
      blocks.push({ kind: "text", markdown: body });
    }
    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        blocks.push({ kind: "image", url: attachment.url, alt: attachment.name });
      } else {
        blocks.push({ kind: "file", url: attachment.url, name: attachment.name ?? "file", mime: attachment.mime ?? undefined });
      }
    }
    const fallback = body || (attachments.length === 1 && attachments[0]?.kind === "image" ? "[image]" : `[${attachments.length} attachments]`);
    const pendingAt = new Date().toISOString();
    const pendingId = `pending-${Date.now()}`;
    const pending: Bubble = {
      id: pendingId,
      author: "You",
      agentId: null,
      mine: true,
      body: fallback,
      sortAt: pendingAt,
      time: new Date(pendingAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      blocks,
      replyTo: replyTo?.id ?? null,
      replyPreview: replyTo?.body.slice(0, 80) ?? null,
      reactions: [],
    };
    setSending(true);
    beginTurn(turnMetaFromScreen().isGroup, turnMetaFromScreen().agentName);
    setDraft("");
    setAttachments([]);
    const target = replyTo;
    setReplyTo(null);
    setNote("");
    setMessages((current) => [...current, pending]);
    // A failed POST must restore the composer so nothing the user wrote is lost.
    // Defensive id: an outdated core returns no message row — keep the pending
    // bubble instead of crashing it away (the old vanishing glitch).
    let confirmedId = pendingId;
    try {
      const saved = await core.sendMessage(accountId.trim(), conversationId, fallback, {
        blocks,
        replyTo: target?.id ?? null,
      });
      if (saved.message?.id) {
        confirmedId = saved.message.id;
        setMessages((current) => current.map((bubble) => (bubble.id === pendingId ? { ...bubble, id: confirmedId } : bubble)));
      }
    } catch (error) {
      setMessages((current) => current.filter((bubble) => bubble.id !== pendingId));
      setDraft(body);
      endTurn(conversationId);
      setSending(false);
      throw error;
    }
    expectReply.current = true;
    setSending(false);
  }

  /**
   * Sends one explicit text as the open chat's next turn.
   * Why: poll widgets answer without touching the composer — draft text the
   * user is typing must survive a tap on Submit. Input: room id + answer
   * text. Output: nothing. The optimistic bubble confirms like a typed send.
   */
  async function sendText(conversationId: string, body: string): Promise<void> {
    const text = body.trim();
    if (!text || sending) {
      return;
    }
    const pendingAt = new Date().toISOString();
    const pendingId = `pending-${Date.now()}`;
    const pending: Bubble = {
      id: pendingId,
      author: "You",
      agentId: null,
      mine: true,
      body: text,
      sortAt: pendingAt,
      time: new Date(pendingAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      blocks: [{ kind: "text", markdown: text }],
      replyTo: null,
      replyPreview: null,
      reactions: [],
    };
    setSending(true);
    beginTurn(turnMetaFromScreen().isGroup, turnMetaFromScreen().agentName);
    setNote("");
    setMessages((current) => [...current, pending]);
    let confirmedId = pendingId;
    try {
      const saved = await core.sendMessage(accountId.trim(), conversationId, text, {
        blocks: [{ kind: "text", markdown: text }],
        replyTo: null,
      });
      if (saved.message?.id) {
        confirmedId = saved.message.id;
        setMessages((current) => current.map((bubble) => (bubble.id === pendingId ? { ...bubble, id: confirmedId } : bubble)));
      }
    } catch (error) {
      setMessages((current) => current.filter((bubble) => bubble.id !== pendingId));
      endTurn(conversationId);
      setSending(false);
      throw error;
    }
    expectReply.current = true;
    setSending(false);
  }

  /**
   * Saves one vault secret from a secret widget.
   * Why: the masked value must never enter chat — it posts straight to the
   * write-only vault. Input: env name + secret. Output: nothing. Throws
   * after noting so the widget keeps the typed value on failure.
   */
  async function saveVaultSecret(name: string, secret: string): Promise<void> {
    try {
      await core.saveSecret(accountId.trim(), { name, secret });
      notify("Secret saved");
      if (conversationId) {
        beginTurn(turnMetaFromScreen().isGroup, turnMetaFromScreen().agentName);
        expectReply.current = true;
        await core.wakeCue(accountId.trim(), conversationId, {
          cue: `Person saved secret ${name} to the vault. Continue using that env name — never ask them to paste it again.`,
        });
      }
    } catch (error) {
      show(error);
      throw error;
    }
  }

  /**
   * Records a question-widget pick without posting a user chat bubble.
   * Why: taps must stay on the card; waking the agent with a cue keeps the
   * thread clean (no "b" / "4" bubbles from option values).
   */
  async function answerQuestion(
    conversationId: string,
    messageId: string,
    pick: { value: string; label: string },
  ): Promise<void> {
    beginTurn(turnMetaFromScreen().isGroup, turnMetaFromScreen().agentName);
    expectReply.current = true;
    setNote("");
    setMessages((current) =>
      current.map((bubble) => {
        if (bubble.id !== messageId || !bubble.blocks) return bubble;
        return {
          ...bubble,
          blocks: bubble.blocks.map((block) =>
            block.kind === "widget" && (block.widget === "question" || block.widget === "desktop-handover")
              ? { ...block, props: { ...block.props, selected: pick.value } }
              : block,
          ),
        };
      }),
    );
    await core.wakeCue(accountId.trim(), conversationId, {
      cue:
        pick.value === "done" || pick.value === "skip"
          ? `Person answered your computer card: "${pick.label}". ${pick.value === "done" ? "They finished the step on your computer; check the screen and carry on." : "They skipped that step; carry on without it, or say plainly what is now blocked."}`
          : `Person tapped your question and chose "${pick.label}" (value: ${pick.value}). Continue from that choice.`,
      messageId,
      selected: pick.value,
    });
  }

  const MAX_IMAGE_BYTES = 5_000_000;
  const MAX_FILE_BYTES = 2_000_000;

  /**
   * Picks one image from the library and stages it as an attachment.
   * Why: images travel as data URIs inside image blocks so the agent's vision
   * grounding receives pixels, not a phone-local path it cannot open.
   * Compresses to cap the row size. Input: none (uses picker UI). Output: nothing.
   */
  async function stagePickedImage(asset: ImagePicker.ImagePickerAsset): Promise<void> {
    if (!asset.base64) {
      setNote("That image could not be read. Try another.");
      return;
    }
    const bytes = Math.floor((asset.base64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      setNote("That image is too large (over 5MB). Try a smaller one.");
      return;
    }
    const mime = asset.mimeType ?? "image/jpeg";
    const url = `data:${mime};base64,${asset.base64}`;
    try {
      await core.upload(accountId.trim(), { url, name: asset.fileName ?? "image" });
    } catch (error) {
      show(error);
      return;
    }
    setAttachments((current) => [
      ...current,
      { id: `att-${Date.now()}`, kind: "image", url, name: asset.fileName ?? "image", mime },
    ]);
  }

  async function pickImage(): Promise<void> {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNote("Photo access is needed to attach images.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync(imageLibraryPickerOptions());
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    await stagePickedImage(picked.assets[0]!);
  }

  async function pickCamera(): Promise<void> {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setNote("Camera access is needed to take a photo.");
      return;
    }
    const picked = await ImagePicker.launchCameraAsync(cameraPickerOptions());
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    await stagePickedImage(picked.assets[0]!);
  }

  /**
   * Picks one file and stages it as an attachment.
   * Why: small working files (text, csv, pdf) embed as data URIs in file
   * blocks so the agent can read them on its Linux. Hard-capped at 2MB to
   * keep rows and prompts bounded; larger files need object storage (later seam).
   * Input: none (uses picker UI). Output: nothing.
   */
  async function pickFile(): Promise<void> {
    const picked = await DocumentPicker.getDocumentAsync(documentPickerOptions());
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    const asset = picked.assets[0]!;
    // A browser has no file system to read from; the picker hands over the file itself.
    if (process.env.EXPO_OS === "web" && asset.file) {
      await stageFiles([asset.file]);
      return;
    }
    if (asset.size != null && asset.size > MAX_FILE_BYTES) {
      setNote("That file is too large (over 2MB).");
      return;
    }
    let base64: string;
    try {
      base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" });
    } catch {
      setNote("That file could not be read.");
      return;
    }
    if (Math.floor((base64.length * 3) / 4) > MAX_FILE_BYTES) {
      setNote("That file is too large (over 2MB).");
      return;
    }
    const mime = asset.mimeType ?? "application/octet-stream";
    const url = `data:${mime};base64,${base64}`;
    try {
      await core.upload(accountId.trim(), { url, name: asset.name });
    } catch (error) {
      show(error);
      return;
    }
    setAttachments((current) => [
      ...current,
      { id: `att-${Date.now()}`, kind: "file", url, name: asset.name, mime },
    ]);
  }

  /**
   * Stages files from a browser: dropped on the chat, pasted into it, or picked.
   * Why: on a computer people drag a file in or paste a screenshot rather than
   * open a picker. Pictures go as pictures, anything else as a file, with the
   * same size limits as the phone's pickers.
   * Input: browser File objects. Output: nothing; the ones that fit are staged.
   */
  async function stageFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const image = /^image\/(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i.test(file.type);
      const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      const name = file.name || (image ? "image" : "file");
      if (file.size > limit) {
        setNote(`${name} is too large (over ${image ? "5MB" : "2MB"}).`);
        continue;
      }
      let url: string;
      try {
        url = await readFileAsDataUrl(file);
      } catch {
        setNote(`${name} could not be read.`);
        continue;
      }
      const mime = file.type || "application/octet-stream";
      try {
        await core.upload(accountId.trim(), { url, name });
      } catch (error) {
        show(error);
        continue;
      }
      setAttachments((current) => [
        ...current,
        { id: `att-${Date.now()}-${current.length}`, kind: image ? "image" : "file", url, name, mime },
      ]);
    }
  }

  /**
   * Toggles one emoji tapback on a bubble and refreshes the row.
   * Why: reactions are idempotent per (message, owner, emoji) server-side.
   */
  async function toggleReaction(conversationId: string, bubble: Bubble, emoji: string): Promise<void> {
    await core.react(accountId.trim(), conversationId, bubble.id, emoji);
    await refreshThread(conversationId, agents);
  }

  /**
   * Loads the latest messages of a team chat for the read-only badge sheet.
   * Input: the group's conversation id. Output: up to 40 plain lines, oldest first.
   */
  async function loadTeamChat(conversationId: string): Promise<{ id: string; author: string; time: string; body: string }[]> {
    const rows = await core.listMessages(accountId.trim(), conversationId);
    return rows.slice(-40).map((row) => ({
      id: row.id,
      author: row.agentId ? (agents.find((agent) => agent.id === row.agentId)?.label ?? agents.find((agent) => agent.id === row.agentId)?.name ?? "Agent") : "You",
      time: new Date(row.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      body: row.body,
    }));
  }

  async function persistAutoReview(value: boolean): Promise<void> {
    setAutoReview(value);
    await core.setAutoReview(accountId.trim(), value);
  }

  /**
   * Loads pending proposals and Auto-review rows, replacing the lists after each decision.
   * Input: optional proposal id and whether the person accepts it. Omit both to only refresh.
   * Output: nothing. The list no longer includes a proposal that was just decided.
   */
  async function refreshProposals(proposalId?: string, accept?: boolean): Promise<void> {
    const next = proposalId
      ? await (accept ? core.approve(accountId.trim(), proposalId) : core.reject(accountId.trim(), proposalId))
      : await core.listProposals(accountId.trim());
    setProposals(next);
    setToolApprovals(await core.listToolApprovals(accountId.trim()).catch(() => []));
    // Deciding a row reloads the list where it is shown (the Approvals page in
    // the account sheet, or the screen); only opening it moves anywhere.
    if (!proposalId && pathnameRef.current !== "/approvals") {
      setMenu(null);
      closeSheet();
      router.push("/approvals");
    }
    setNote("");
  }

  /**
   * Opens the Approvals page at once; the page loads what is waiting itself.
   * Why: the page used to open only after two requests answered, and when one
   * failed, the error went to the chat list behind the sheet, so tapping
   * Approvals seemed to do nothing.
   */
  function openApprovals(): void {
    setMenu(null);
    if (pathnameRef.current !== "/approvals") {
      closeSheet();
      router.push("/approvals");
    }
  }

  /** Reloads what is waiting for approval. Throws, so the Approvals page can say what failed. */
  async function reloadApprovals(): Promise<void> {
    const [proposalRows, toolRows] = await Promise.all([core.listProposals(accountId.trim()), core.listToolApprovals(accountId.trim())]);
    setProposals(proposalRows);
    setToolApprovals(toolRows);
  }

  async function decideToolRow(approvalId: string, accept: boolean, always = false): Promise<void> {
    const status = accept ? "approved" : "denied";
    setMessages((current) =>
      current.map((bubble) => {
        if (!bubble.blocks) return bubble;
        const blocks = bubble.blocks.map((block) => {
          if (block.kind !== "widget" || block.widget !== "approval") return block;
          const props = block.props && typeof block.props === "object" ? block.props : {};
          if ((props as { approvalId?: string }).approvalId !== approvalId) return block;
          return { ...block, props: { ...props, status } };
        });
        return { ...bubble, blocks };
      }),
    );
    const next = accept
      ? await core.approveTool(accountId.trim(), approvalId, always)
      : await core.denyTool(accountId.trim(), approvalId);
    setToolApprovals(next);
  }

  /**
   * Opens the agent profile editor for one agent.
   * Why: one shared path so chat-name taps land on the same form the
   * desktop More menu used to open. Input: the agent. Output: nothing.
   * The profile screen opens on it.
   */
  /**
   * Loads an agent's profile: its settings, routines, and the media, links and
   * files from its chat. The desktop side panel calls it on its own when the
   * person picks another agent with the panel open.
   */
  function loadProfile(agent: RosterAgent): void {
    void core
      .listProviders(accountId.trim())
      .then(setProviders)
      .catch(show);
    void refreshRoutines(agent.id).catch(show);
    setProfile(agent);
    const chat = lastChatRef.current;
    if (chat && chat.kind === "direct" && chat.agent.id === agent.id) {
      setProfileFeed(messages.map((row) => ({ ...row, conversationId: chat.conversationId })));
    } else {
      setProfileFeed([]);
    }
    void loadDirectFeed(agent.id).then(setProfileFeed).catch(show);
  }

  function openProfile(agent: RosterAgent): void {
    loadProfile(agent);
    const chat = lastChatRef.current;
    // In a desktop window the profile opens beside the chat, not over it.
    if (isWideLayout() && chat && chat.kind === "direct" && chat.agent.id === agent.id) setSidePanel("details");
    else router.push(`/profile/${agent.id}`);
  }

  /** Opens the room page for a group instead of the owner's profile. */
  async function openGroupInfo(): Promise<void> {
    const chat = lastChatRef.current;
    if (!chat || chat.kind !== "group") return;
    const roomId = chat.conversationId;
    setGroupFeed(messages.map((row) => ({ ...row, conversationId: roomId })));
    router.push(`/group/${roomId}`);
    const history = await core.listMessages(accountId.trim(), roomId).catch(() => null);
    if (!Array.isArray(history)) return;
    setGroupFeed(toBubbles(history, [], agents).map((row) => ({ ...row, conversationId: roomId })));
  }

  /** Loads one agent's private thread for the profile Links, Media, and Files tabs. */
  async function loadDirectFeed(agentId: string): Promise<(Bubble & { conversationId?: string })[]> {
    const id = accountId.trim();
    const rooms = await core.listConversations(id).catch(() => []);
    const direct = rooms.find((room) => room.kind === "direct" && room.ownerAgentId === agentId);
    if (!direct) return [];
    const history = await core.listMessages(id, direct.id).catch(() => null);
    if (!Array.isArray(history)) return [];
    return toBubbles(history, [], agents).map((row) => ({ ...row, conversationId: direct.id }));
  }

  /**
   * Saves the open profile and updates that agent in the roster.
   * Input: an optional draft (the notifications toggle saves immediately,
   * before state settles). Omit it to save the profile on screen.
   * Output: nothing. The roster shows the saved name, label, and flags.
   */
  /** Pins or hides one roster agent without opening the profile. */
  async function setRosterFlag(agent: RosterAgent, patch: { pinned?: boolean; hidden?: boolean }): Promise<void> {
    const saved = await core.saveProfile(accountId.trim(), agent.id, patch);
    setAgents((rows) => rows.map((row) => (row.id === agent.id ? { ...row, ...saved, ...patch } : row)));
  }

  async function saveProfile(draft?: RosterAgent): Promise<void> {
    const current = draft ?? profile;
    if (!current) {
      return;
    }
    const saved = await core.saveProfile(accountId.trim(), current.id, current);
    setProfile(saved);
    setAgents((rows) => rows.map((agent) => (agent.id === saved.id ? saved : agent)));
    setLastChat((currentChat) =>
      currentChat && currentChat.agent.id === saved.id
        ? { ...currentChat, agent: saved, title: currentChat.kind === "group" ? currentChat.title : saved.name }
        : currentChat,
    );
    notify("Changes saved");
  }

  /**
   * Reloads one agent's routines into the bot info page.
   * Input: the agent id. Output: nothing. The routines group re-renders.
   */
  async function refreshRoutines(agentId: string): Promise<void> {
    setRoutines(await core.listRoutines(accountId.trim(), agentId));
  }

  /**
   * Picks one photo from the library and saves it as the bot's avatar.
   * Why: tapping the big mark on the bot info page replaces the drawn mark
   * with a photo. Images travel as data URIs, validated by the core upload.
   * Input: none (uses picker UI). Output: nothing. The draft shows the photo.
   */
  async function pickAvatar(): Promise<void> {
    if (!profile) {
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setNote("Photo access is needed for the bot photo.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync(imageLibraryPickerOptions());
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    const asset = picked.assets[0]!;
    if (!asset.base64) {
      setNote("That image could not be read. Try another.");
      return;
    }
    if (Math.floor((asset.base64.length * 3) / 4) > MAX_IMAGE_BYTES) {
      setNote("That image is too large (over 5MB). Try a smaller one.");
      return;
    }
    const mime = asset.mimeType ?? "image/jpeg";
    const url = `data:${mime};base64,${asset.base64}`;
    try {
      await core.upload(accountId.trim(), { url, name: asset.fileName ?? "avatar" });
    } catch (error) {
      show(error);
      return;
    }
    await saveProfile({ ...profile, avatarUrl: url });
  }

  /**
   * Pauses or resumes one routine and reloads the group.
   * Input: the routine and the wanted paused flag. Output: nothing.
   */
  async function pauseRoutine(routine: Routine, paused: boolean): Promise<void> {
    if (!profile) {
      return;
    }
    await core.updateRoutine(accountId.trim(), profile.id, routine.id, { paused });
    await refreshRoutines(profile.id);
  }

  /**
   * Saves one account-scoped provider credential and refreshes the safe metadata.
   * Input: provider name, a new secret or blank to retain it, and an optional local URL.
   * Output: nothing. The phone never receives the saved secret.
   */
  async function saveProvider(
    provider: ProviderSetting["provider"],
    secret: string,
    baseUrl: string | null,
  ): Promise<void> {
    const saved = await core.saveProvider(accountId, { provider, secret, baseUrl });
    setProviders(await core.listProviders(accountId));
    // A server with no model list is saved unchecked, and the person is told so.
    notify(saved.note ?? "Provider checked and saved");
  }

  /**
   * Finishes first-time setup: saves the provider key and the default model.
   * The core then creates the default agent, and its chat opens as it writes its first message.
   * Input: provider, a new key (blank keeps a saved one), an optional server address, and the model id.
   */
  async function finishSetup(
    provider: ProviderSetting["provider"],
    secret: string,
    baseUrl: string | null,
    modelId: string,
  ): Promise<void> {
    if (secret || baseUrl) await core.saveProvider(accountId, { provider, secret, baseUrl });
    setDefaultModel(await core.setDefaultModel(accountId, { provider, modelId }));
    setProviders(await core.listProviders(accountId));
    const rows = await core.listAgents(accountId);
    setAgents(rows);
    const support = rows.find((agent) => agent.kind === "support");
    setSetupNeeded(!support);
    if (support) await openAgent(support);
  }

  /** Changes the model new agents start on. Input: provider and model id. */
  async function saveDefaultModel(provider: ProviderSetting["provider"], modelId: string): Promise<void> {
    setDefaultModel(await core.setDefaultModel(accountId, { provider, modelId }));
    notify("Default model saved");
  }

  /** Sets the cheaper model background work runs on, or clears it with a null model id. */
  async function saveCheapModel(provider: ProviderSetting["provider"], modelId: string | null): Promise<void> {
    setCheapModel(await core.setCheapModel(accountId, modelId ? { provider, modelId } : null));
    notify(modelId ? "Cheap model saved" : "Cheap model removed");
  }

  async function refreshPlugins(): Promise<void> {
    if (!accountId) return;
    setPlugins(await core.listPlugins(accountId));
  }

  async function addPlugin(id: string): Promise<void> {
    const row = plugins?.plugins.find((plugin) => plugin.id === id);
    if (row?.kind !== "google") return;
    const started = await core.startGooglePlugin(accountId, id);
    if (started.installed) {
      await refreshPlugins();
      return;
    }
    await Linking.openURL(started.url);
  }

  async function saveCustomPlugin(name: string, url: string, secret: string): Promise<void> {
    await core.saveMcpPlugin(accountId, { slug: pluginSlug(name), url: url.trim(), secret });
    await refreshPlugins();
    setMenu("plugins");
  }

  async function signInCustomPlugin(name: string, url: string): Promise<void> {
    const started = await core.startMcpPlugin(accountId, pluginSlug(name), url.trim());
    await Linking.openURL(started.url);
  }

  function openAccount(page: MenuPage): void {
    setMenu(page);
    if (page === "plugins") void refreshPlugins().catch(show);
    router.push("/account");
  }

  function openNewRoom(): void {
    if (!accountId) {
      setAfterSignup(true);
      openAccount("signup");
      return;
    }
    router.push("/new-room");
  }

  function openDesktop(agent: RosterAgent): void {
    setDesktopAgent(agent);
    closeSheet();
    // In a desktop window the open chat's agent gets its screen large in the
    // side panel: the same live screen, with no new page or connection.
    const chat = lastChatRef.current;
    if (isWideLayout() && chat?.kind === "direct" && chat.agent.id === agent.id) setSidePanel("screen");
    else router.push(`/desktop/${agent.id}`);
  }

  function leaveChat(roomId: string): void {
    if (enteringRef.current === roomId) enteringRef.current = "";
    setConversationId((current) => (current === roomId ? "" : current));
  }

  const value: SessionValue = {
    accounts,
    accountId,
    account,
    agents,
    providers,
    plugins,
    menu,
    setMenu,
    toast,
    draft,
    setDraft,
    messages,
    sending,
    setSending,
    roomActivity,
    threadLoading,
    replyTo,
    setReplyTo,
    attachments,
    setAttachments,
    note,
    setNote,
    proposals,
    toolApprovals,
    routines,
    groupFeed,
    profileFeed,
    profile,
    setProfile,
    conversationId,
    contextRing,
    groups,
    lastChat,
    desktopAgent,
    notifications,
    setNotifications,
    pendingCount,
    inbox,
    autoReview,
    autoTimeZone,
    setAutoTimeZone,
    timeZone,
    show,
    signInWithGoogle,
    openAgent,
    openGroup,
    send,
    sendText,
    pickImage,
    pickCamera,
    pickFile,
    stageFiles,
    toggleReaction,
    loadOlderMessages,
    loadTeamChat,
    persistAutoReview,
    refreshProposals,
    decideToolRow,
    openApprovals,
    reloadApprovals,
    openProfile,
    loadProfile,
    openGroupInfo,
    saveProfile,
    pickAvatar,
    pauseRoutine,
    saveProvider,
    finishSetup,
    saveDefaultModel,
    defaultModel,
    saveCheapModel,
    cheapModel,
    setupNeeded,
    refreshPlugins,
    addPlugin,
    saveCustomPlugin,
    signInCustomPlugin,
    setRosterFlag,
    answerQuestion,
    saveVaultSecret,
    openAccount,
    openNewRoom,
    openDesktop,
    sidePanel,
    setSidePanel,
    leaveChat,
    createChat,
    askForAgent,
    createGroup,
    serverUrl,
    versionNote,
    changeServer,
    restored,
    reload: refreshSession,
    signOut,
    deleteAccount,
    switchAccount,
    addAccount,
    removePlugin(id: string) {
      void core.deleteMcpPlugin(accountId, id).then(refreshPlugins).catch(show);
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside SessionProvider");
  }
  return value;
}

type SessionValue = {
  accounts: SavedAccount[];
  accountId: string;
  account: SignedAccount | null;
  agents: RosterAgent[];
  providers: ProviderSetting[];
  plugins: PluginList | null;
  menu: MenuPage | null;
  setMenu: (page: MenuPage | null) => void;
  draft: string;
  toast: ToastMessage | null;
  setDraft: (value: string) => void;
  messages: Bubble[];
  sending: boolean;
  setSending: (value: boolean) => void;
  roomActivity: RoomActivityPhase | null;
  /** True while a chat seen for the first time is loading its messages. */
  threadLoading: boolean;
  replyTo: Bubble | null;
  setReplyTo: (bubble: Bubble | null) => void;
  attachments: Attachment[];
  setAttachments: (value: Attachment[] | ((current: Attachment[]) => Attachment[])) => void;
  note: string;
  setNote: (value: string) => void;
  proposals: Proposal[];
  toolApprovals: ToolApproval[];
  routines: Routine[];
  groupFeed: (Bubble & { conversationId?: string })[];
  profileFeed: (Bubble & { conversationId?: string })[];
  profile: RosterAgent | null;
  setProfile: (agent: RosterAgent | null) => void;
  conversationId: string;
  contextRing: { share: number; hint: string } | null;
  groups: { id: string; title: string; memberCount: number; members: GroupFace[] }[];
  lastChat: ChatTarget | null;
  desktopAgent: RosterAgent | null;
  notifications: boolean;
  setNotifications: (value: boolean) => void;
  pendingCount: number;
  /** Unread counts and busy agents for the inbox list; null until first loaded. */
  inbox: InboxStatus | null;
  autoReview: boolean;
  autoTimeZone: boolean;
  setAutoTimeZone: (value: boolean) => void;
  timeZone: string;
  show: (error: unknown) => void;
  signInWithGoogle: () => Promise<void>;
  openAgent: (agent: RosterAgent) => Promise<void>;
  openGroup: (roomId: string) => Promise<void>;
  send: (conversationId: string) => Promise<void>;
  sendText: (conversationId: string, body: string) => Promise<void>;
  pickImage: () => Promise<void>;
  pickCamera: () => Promise<void>;
  pickFile: () => Promise<void>;
  /** Stages browser files (drag and drop, paste) as attachments. */
  stageFiles: (files: File[]) => Promise<void>;
  toggleReaction: (conversationId: string, bubble: Bubble, emoji: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  loadTeamChat: (conversationId: string) => Promise<{ id: string; author: string; time: string; body: string }[]>;
  persistAutoReview: (value: boolean) => Promise<void>;
  refreshProposals: (proposalId?: string, accept?: boolean) => Promise<void>;
  decideToolRow: (approvalId: string, accept: boolean, always?: boolean) => Promise<void>;
  openApprovals: () => void;
  reloadApprovals: () => Promise<void>;
  openProfile: (agent: RosterAgent) => void;
  /** Loads an agent's profile without opening a page (the desktop side panel). */
  loadProfile: (agent: RosterAgent) => void;
  openGroupInfo: () => Promise<void>;
  saveProfile: (draft?: RosterAgent) => Promise<void>;
  pickAvatar: () => Promise<void>;
  pauseRoutine: (routine: Routine, paused: boolean) => Promise<void>;
  saveProvider: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null) => Promise<void>;
  finishSetup: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null, modelId: string) => Promise<void>;
  saveDefaultModel: (provider: ProviderSetting["provider"], modelId: string) => Promise<void>;
  defaultModel: DefaultModelSetting | null;
  saveCheapModel: (provider: ProviderSetting["provider"], modelId: string | null) => Promise<void>;
  cheapModel: DefaultModelSetting | null;
  setupNeeded: boolean;
  refreshPlugins: () => Promise<void>;
  addPlugin: (id: string) => Promise<void>;
  saveCustomPlugin: (name: string, url: string, secret: string) => Promise<void>;
  signInCustomPlugin: (name: string, url: string) => Promise<void>;
  setRosterFlag: (agent: RosterAgent, patch: { pinned?: boolean; hidden?: boolean }) => Promise<void>;
  answerQuestion: (conversationId: string, messageId: string, pick: { value: string; label: string }) => Promise<void>;
  saveVaultSecret: (name: string, secret: string) => Promise<void>;
  openAccount: (page: MenuPage) => void;
  openNewRoom: () => void;
  openDesktop: (agent: RosterAgent) => void;
  /** Desktop window only: the panel beside the chat. */
  sidePanel: SidePanel | null;
  setSidePanel: (panel: SidePanel | null) => void;
  leaveChat: (roomId: string) => void;
  createChat: (name: string, look?: AgentMark) => Promise<void>;
  askForAgent: (support: RosterAgent, name: string) => Promise<void>;
  createGroup: (title: string, agentIds: string[]) => Promise<void>;
  signOut: () => Promise<void>;
  /** Deletes the signed-in account on the server, for good. */
  deleteAccount: () => Promise<void>;
  /** Reads the signed-in account, its agents and its chats again from the server. */
  reload: () => Promise<void>;
  /** Makes another account signed in on this phone the one in use. */
  switchAccount: (slot: string) => Promise<void>;
  /** Signs in one more account, keeping the others signed in. */
  addAccount: () => Promise<void>;
  /** True once the saved sign-in has been checked at start-up. */
  restored: boolean;
  /** The server the app talks to. */
  serverUrl: string;
  /** One sentence when the app or the server needs updating to work with the other; otherwise null. */
  versionNote: string | null;
  /** Points the app at another server; "" goes back to the build's own. */
  changeServer: (typed: string) => Promise<void>;
  removePlugin: (id: string) => void;
};


