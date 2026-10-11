import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { router, usePathname } from "expo-router";
import type { MenuPage, SignedAccount } from "../account/MenuSheet";
import { authCallbackURL } from "../auth-callback-url";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  configureAuthCookie,
  contextLine as formatContextLine,
  contextUsageShare,
  createCore,
  type AccountSettings,
  type DefaultModelSetting,
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
import { blocksFromMaybeWidgetText, expandWidgetMarkupBlocks } from "@nano-agents/shared";
import {
  configureForegroundBanners,
  ensureLocalNotificationsReady,
  getPushToken,
  onPushTap,
  scheduleLocalNotification,
} from "../push";
import { authClient } from "../auth";
import { installOAuthReturnHandler } from "../auth-oauth-return";
import * as WebBrowser from "expo-web-browser";
import { coreBaseUrl } from "../core-url";
import { pluginSlug } from "../account/PluginsPage";
import type { Bubble } from "../chat/ChatScreen";
import type { RoomActivityPhase } from "../chat/room-activity";
import { hydrateMarkThumbCache, warmMarkThumbs } from "../ui/DotStage";
import { resolveMarkLook } from "../ui/Mark";
import { documentPickerOptions } from "../media/documentPickerOptions";
import { cameraPickerOptions, imageLibraryPickerOptions } from "../media/imagePickerOptions";
import type { GroupFace } from "../ui/GroupCluster";
import type { ToastMessage } from "../ui/Toast";

configureAuthCookie(authClient.getCookie);
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

export type ChatTarget = {
  agent: RosterAgent;
  conversationId: string;
  kind: "direct" | "group";
  title: string;
  subtitle: string;
  memberIds: string[];
};

function closeSheets(): void {
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
  const [accounts, setAccounts] = useState<SignedAccount[]>([]);
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
  const [notifications, setNotifications] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [autoReview, setAutoReview] = useState(true);
  const [defaultModel, setDefaultModel] = useState<DefaultModelSetting | null>(null);
  // True for a signed-in account that has no default agent yet: the inbox shows the setup guide.
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [autoTimeZone, setAutoTimeZone] = useState(true);
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const account = accounts.find((row) => row.id === accountId) ?? null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * Shows a request error on the screen.
   * Input: the thrown value.
   * Output: nothing. The note becomes the error message.
   */
  const show = useCallback((error: unknown): void => {
    const text = error instanceof Error ? error.message : "The request failed.";
    setNote(text);
    // Sheets have no error line of their own, so the banner carries it there.
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
      return;
    }
    const next = { id: accountIdFromSession, name: signed.name, email: signed.email };
    setAccounts([next]);
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
    setSetupNeeded(!roster.some((agent) => agent.kind === "support"));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) {
      await core.rememberTimezone(accountIdFromSession, zone).catch(() => {});
    }
    setMenu(null);
    closeSheets();
    // Only leave for the inbox when some other screen is up (sign-in return).
    // On a cold start the inbox is already showing; replacing it there threw
    // away the list that had just drawn and built it a second time.
    if (pathnameRef.current !== "/") {
      router.replace("/");
    }
    setNote("");
    await loadGroups(accountIdFromSession, roster);
    // Best-effort push registration + badge: no EAS projectId, denied
    // permission, or network failure all degrade to SSE/polling silently.
    try {
      const push = await getPushToken();
      if (push) {
        await core.registerDevice(accountIdFromSession, { expoPushToken: push.token, platform: push.platform });
      }
      const pending = await core.listNotifications(accountIdFromSession).catch(() => []);
      setPendingCount(pending.length);
    } catch {
      // Push unavailable; the thread still streams when open.
    }
  }

  /**
   * Signs in with Google and keeps the account id the core creates.
   * Input: none. Google returns the session.
   * Output: nothing. Later chats and groups use that account id.
   */
  async function signInWithGoogle(): Promise<void> {
    const base = coreBaseUrl();
    try {
      const probe = await fetch(`${base}/api/auth/get-session`);
      if (!probe.ok) {
        throw new Error(`Core auth returned ${probe.status}.`);
      }
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.includes("Core auth")
          ? error.message
          : `Cannot reach core at ${base}. Set EXPO_PUBLIC_CORE_URL in apps/mobile/.env (e.g. https://api.example.com), stop Metro, run pnpm --filter mobile start:clear, then reload Expo Go. Still seeing an old 192.168… URL? Clear Expo Go app data or reinstall.`,
      );
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
    void refreshSession().catch(show);
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
    const pull = async (): Promise<void> => {
      const pending = await core.listNotifications(id).catch(() => []);
      if (stopped) return;
      setPendingCount(pending.length);
      const canNotify = notifications && (await ensureLocalNotificationsReady());
      for (const note of pending) {
        if (shown.has(note.id)) continue;
        shown.add(note.id);
        setNote(`${note.title}: ${note.body}`.slice(0, 180));
        if (canNotify) {
          await scheduleLocalNotification({
            title: note.title,
            body: note.body,
            data: { conversationId: note.conversationId, notificationId: note.id },
          }).catch(() => {});
        }
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

  useEffect(() => {
    configureForegroundBanners();
    return onPushTap((data) => {
      // A push tap carries the exact room — open it instead of the inbox.
      // Badge reconciles on foreground; the room shows the full result.
      const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
      if (!conversationId) return;
      void openGroup(conversationId).catch(show);
    });
  }, [show]);

  /**
   * Loads the roster for one signed-in account.
   * Input: the account id chosen in the switcher.
   * Output: nothing. The inbox shows that account's agents.
   */
  async function switchAccount(id: string): Promise<void> {
    setAccountId(id);
    const roster = await core.listAgents(id);
    setAgents(roster);
    setProviders(await core.listProviders(id));
    setDefaultModel((await core.getSettings(id).catch(() => null))?.defaultModel ?? null);
    setSetupNeeded(!roster.some((agent) => agent.kind === "support"));
    setMenu("menu");
    setNote("");
    await loadGroups(id, roster);
    const pending = await core.listNotifications(id).catch(() => []);
    setPendingCount(pending.length);
  }

  /**
   * Hires an agent and opens a direct chat on the signed-in account.
   * Why: role + job ship with the hire so the agent starts with identity, not a blob.
   * Input: the agent name, role, and job from the new-room sheet.
   * Output: nothing. The chat screen opens for that agent.
   */
  async function createChat(
    name: string,
    role: string,
    jobDescription: string,
    provider: ProviderSetting["provider"],
    modelId: string,
    kind: "work" | "companion" = "work",
  ): Promise<void> {
    if (!accountId.trim()) {
      throw new Error("Sign in first, then create a chat.");
    }
    const hired = await core.hireAgent(accountId, { name, role, jobDescription, kind, provider, modelId });
    const room = await core.openChat(accountId, hired);
    // The agent opens the chat itself; if that fails the chat just starts empty.
    void core.sayHello(accountId, room.id).catch(() => {});
    const rows = await core.listAgents(accountId);
    const fresh = rows.find((row) => row.id === hired.id) ?? hired;
    setAgents(rows);
    await enterRoom({ id: room.id, kind: "direct", title: fresh.name, ownerAgentId: fresh.id }, rows);
    await loadGroups(accountId, rows);
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
        setNote(`${event.notification.title}: ${event.notification.body}`.slice(0, 160));
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
    const [memberRows, history, taps] = await Promise.all([
      core.listMembers(id, room.id).catch(() => [{ agentId: owner.id }]),
      core.listMessages(id, room.id, { limit: THREAD_PAGE }),
      core.listReactions(id, room.id),
    ]);
    olderRef.current = { roomId: room.id, more: history.length >= THREAD_PAGE, loading: false };
    const kind = room.kind === "group" ? ("group" as const) : ("direct" as const);
    const names = memberRows.map((member) => roster.find((row) => row.id === member.agentId)?.name ?? "Agent");
    const opened = {
      agent: owner,
      conversationId: room.id,
      kind,
      title: kind === "group" ? room.title : owner.name,
      subtitle: kind === "group" ? names.join(", ").slice(0, 60) : "",
      memberIds: memberRows.map((member) => member.agentId),
    };
    const leaving = lastChatRef.current?.conversationId;
    if (leaving) draftsRef.current.set(leaving, draftRef.current);
    setAgents(roster);
    setConversationId(room.id);
    setLastChat(opened);
    closeSheets();
    router.push(`/chat/${room.id}`);
    setContextRing(null);
    void loadContextLine(room.id);
    setMessages(toBubbles(history, taps, roster));
    setDraft(draftsRef.current.get(room.id) ?? "");
    setReplyTo(null);
    setAttachments([]);
    setNote("");
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
            block.kind === "widget" && block.widget === "question"
              ? { ...block, props: { ...block.props, selected: pick.value } }
              : block,
          ),
        };
      }),
    );
    await core.wakeCue(accountId.trim(), conversationId, {
      cue: `Person tapped your question and chose "${pick.label}" (value: ${pick.value}). Continue from that choice.`,
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
    setMenu(null);
    closeSheets();
    router.push("/approvals");
    setNote("");
  }

  async function decideToolRow(approvalId: string, accept: boolean): Promise<void> {
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
      ? await core.approveTool(accountId.trim(), approvalId)
      : await core.denyTool(accountId.trim(), approvalId);
    setToolApprovals(next);
  }

  /**
   * Opens the agent profile editor for one agent.
   * Why: one shared path so chat-name taps land on the same form the
   * desktop More menu used to open. Input: the agent. Output: nothing.
   * The profile screen opens on it.
   */
  function openProfile(agent: RosterAgent): void {
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
    router.push(`/profile/${agent.id}`);
    void loadDirectFeed(agent.id).then(setProfileFeed).catch(show);
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
    await core.saveProvider(accountId, { provider, secret, baseUrl });
    setProviders(await core.listProviders(accountId));
    notify("Provider saved");
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
    closeSheets();
    router.push(`/desktop/${agent.id}`);
  }

  function leaveChat(roomId: string): void {
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
    toggleReaction,
    loadOlderMessages,
    loadTeamChat,
    persistAutoReview,
    refreshProposals,
    decideToolRow,
    openProfile,
    openGroupInfo,
    saveProfile,
    pickAvatar,
    pauseRoutine,
    saveProvider,
    finishSetup,
    saveDefaultModel,
    defaultModel,
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
    leaveChat,
    switchAccount,
    createChat,
    createGroup,
    signOut() {
      void authClient.signOut().catch(show);
      setAccountId("");
      setAgents([]);
      setMenu("signup");
    },
    deleteAccount(id: string) {
      setAccounts((rows) => rows.filter((row) => row.id !== id));
      if (accountId === id) {
        setAccountId("");
        setAgents([]);
        setMenu("signup");
      }
    },
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
  accounts: SignedAccount[];
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
  toggleReaction: (conversationId: string, bubble: Bubble, emoji: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  loadTeamChat: (conversationId: string) => Promise<{ id: string; author: string; time: string; body: string }[]>;
  persistAutoReview: (value: boolean) => Promise<void>;
  refreshProposals: (proposalId?: string, accept?: boolean) => Promise<void>;
  decideToolRow: (approvalId: string, accept: boolean) => Promise<void>;
  openProfile: (agent: RosterAgent) => void;
  openGroupInfo: () => Promise<void>;
  saveProfile: (draft?: RosterAgent) => Promise<void>;
  pickAvatar: () => Promise<void>;
  pauseRoutine: (routine: Routine, paused: boolean) => Promise<void>;
  saveProvider: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null) => Promise<void>;
  finishSetup: (provider: ProviderSetting["provider"], secret: string, baseUrl: string | null, modelId: string) => Promise<void>;
  saveDefaultModel: (provider: ProviderSetting["provider"], modelId: string) => Promise<void>;
  defaultModel: DefaultModelSetting | null;
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
  leaveChat: (roomId: string) => void;
  switchAccount: (id: string) => Promise<void>;
  createChat: (
    name: string,
    role: string,
    jobDescription: string,
    provider: ProviderSetting["provider"],
    modelId: string,
    kind?: "work" | "companion",
  ) => Promise<void>;
  createGroup: (title: string, agentIds: string[]) => Promise<void>;
  signOut: () => void;
  deleteAccount: (id: string) => void;
  removePlugin: (id: string) => void;
};


