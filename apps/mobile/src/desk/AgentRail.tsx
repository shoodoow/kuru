import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { RosterAgent } from "../api";
import { useSession } from "../session/SessionProvider";
import * as Store from "../store";
import { useResolvedScheme } from "../theme/appearance";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { GroupCluster } from "../ui/GroupCluster";
import { IconPlus, IconSearch, IconSidebar } from "../ui/icons";

const FACE = 44;
/** Whether the sidebar was left open, kept on this computer. */
const OPEN_KEY = "kuru.sidebar-open";

type Hovered = { pressed: boolean; hovered?: boolean };

/**
 * The sidebar of the desktop window: the phone's chat list down the left edge.
 * Closed, it is a column of faces. Open, each row also has the name, label,
 * and what the agent does (or "Working…"), with search at the top.
 * A blue dot means the agent is working and a count means unread messages.
 * Input: none; it reads the session. Output: the sidebar.
 */
export function AgentRail() {
  useResolvedScheme();
  const session = useSession();
  const [open, setOpen] = useState(() => readOpen());
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  const openId = session.conversationId ? session.lastChat?.conversationId : null;
  const openAgentId = session.lastChat?.kind === "direct" && openId ? session.lastChat.agent.id : null;
  const marks = useMemo(() => {
    const working = new Set(session.inbox?.workingAgentIds ?? []);
    const unread = new Map<string, number>();
    const rooms = new Map<string, { unread: number; working: boolean }>();
    for (const room of session.inbox?.rooms ?? []) {
      rooms.set(room.id, room);
      if (room.kind === "direct") unread.set(room.ownerAgentId, (unread.get(room.ownerAgentId) ?? 0) + room.unread);
    }
    return { working, unread, rooms };
  }, [session.inbox]);
  const needle = query.trim().toLowerCase();
  const agents = useMemo(() => {
    const shown = session.agents.filter((agent) => !agent.hidden && matches(needle, agent.name, agent.label, agent.role));
    return [...shown.filter((agent) => agent.pinned), ...shown.filter((agent) => !agent.pinned)];
  }, [session.agents, needle]);
  const groups = session.groups.filter((group) => matches(needle, group.title));

  function toggleOpen(): void {
    const next = !open;
    setOpen(next);
    if (!next) closeSearch();
    try {
      Store.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; it still works for now.
    }
  }

  function closeSearch(): void {
    setSearching(false);
    setQuery("");
  }

  if (!session.account || session.setupNeeded) return null;
  return (
    <View style={[styles.rail, open ? styles.railOpen : null]}>
      <View style={[styles.head, open ? styles.headOpen : null]}>
        <Tool label={open ? "Close sidebar" : "Open sidebar"} onPress={toggleOpen}>
          <IconSidebar />
        </Tool>
        {open ? (
          <View style={styles.headActions}>
            <Tool label="Search" onPress={() => (searching ? closeSearch() : setSearching(true))}>
              <IconSearch />
            </Tool>
            <Tool label="New chat" onPress={() => session.openNewRoom()}>
              <IconPlus />
            </Tool>
          </View>
        ) : null}
      </View>
      {open && searching ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={colors.muted}
          autoFocus
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Escape") closeSearch();
          }}
          style={styles.search}
        />
      ) : null}
      <ScrollView contentContainerStyle={[styles.list, open ? styles.listOpen : null]} showsVerticalScrollIndicator={false}>
        {agents.map((agent) => {
          const working = marks.working.has(agent.id);
          return (
            <Row
              key={agent.id}
              open={open}
              title={agent.name}
              label={agent.label && agent.label !== agent.name ? agent.label : null}
              subtitle={working ? "Working…" : agent.role || `Message ${agent.name}`}
              selected={agent.id === openAgentId}
              working={working}
              unread={marks.unread.get(agent.id) ?? 0}
              face={<AgentFace agent={agent} working={working} />}
              onPress={() => void session.openAgent(agent).catch(session.show)}
            />
          );
        })}
        {groups.map((group) => {
          const mark = marks.rooms.get(group.id);
          return (
            <Row
              key={group.id}
              open={open}
              title={group.title}
              subtitle={mark?.working ? "Working…" : `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`}
              selected={group.id === openId}
              working={mark?.working ?? false}
              unread={mark?.unread ?? 0}
              face={<GroupCluster members={group.members.slice(0, 2)} size={26} />}
              onPress={() => void session.openGroup(group.id).catch(session.show)}
            />
          );
        })}
        {open && needle && agents.length === 0 && groups.length === 0 ? <Text style={styles.empty}>No matches</Text> : null}
      </ScrollView>
      <View style={[styles.foot, open ? styles.footOpen : null]}>
        {open ? null : (
          <Tool label="New chat" onPress={() => session.openNewRoom()}>
            <IconPlus />
          </Tool>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account"
          {...({ title: "Account" } as object)}
          onPress={() => session.openAccount("menu")}
          style={({ pressed, hovered }: Hovered) => [styles.account, open ? styles.accountOpen : null, hovered ? styles.hover : null, pressed ? styles.pressed : null]}
        >
          <Avatar id={session.account.id} size={34} person label={session.account.name} photo={session.account.image} />
          {open ? (
            <Text style={styles.accountName} numberOfLines={1}>
              {session.account.name}
            </Text>
          ) : null}
        </Pressable>
      </View>
    </View>
  );
}

/** Reads whether the sidebar was left open. Closed when nothing is saved. */
function readOpen(): boolean {
  try {
    return Store.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** True when the search text is empty or found in any of the given texts. */
function matches(needle: string, ...texts: (string | null | undefined)[]): boolean {
  return !needle || texts.some((text) => text?.toLowerCase().includes(needle));
}

/** One chat in the sidebar: just the face when closed, the face and its text when open. */
function Row({
  open,
  title,
  label = null,
  subtitle,
  selected,
  working,
  unread,
  face,
  onPress,
}: {
  open: boolean;
  title: string;
  label?: string | null;
  subtitle: string;
  selected: boolean;
  working: boolean;
  unread: number;
  face: ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, working ? "working" : "", unread > 0 ? `${unread} unread` : ""].filter(Boolean).join(", ")}
      accessibilityState={{ selected }}
      // Closed, the browser shows the name as a tooltip on hover.
      {...(open ? null : ({ title } as object))}
      onPress={onPress}
      style={({ pressed, hovered }: Hovered) => [
        open ? styles.row : styles.slot,
        selected ? styles.selected : hovered ? styles.hover : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.face}>
        {face}
        {working ? <View style={styles.working} /> : null}
        {open ? null : <Unread count={unread} />}
      </View>
      {open ? (
        <View style={styles.rowText}>
          <View style={styles.rowTop}>
            <Text style={[styles.title, unread > 0 ? styles.titleUnread : null]} numberOfLines={1}>
              {title}
            </Text>
            {label ? (
              <View style={styles.label}>
                <Text style={styles.labelText} numberOfLines={1}>
                  {label}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.subtitle, working ? styles.subtitleWorking : null]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      ) : null}
      {open ? <Unread count={unread} inline /> : null}
    </Pressable>
  );
}

function AgentFace({ agent, working }: { agent: RosterAgent; working: boolean }) {
  return (
    <Avatar
      id={agent.id}
      size={FACE}
      shape={agent.markShape}
      color={agent.markColor}
      material={agent.markMaterial}
      style={agent.markStyle}
      gender={agent.markGender}
      photo={agent.avatarUrl}
      mood={working ? "working" : "idle"}
    />
  );
}

/** A round button in the sidebar's header or foot. */
function Tool({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...({ title: label } as object)}
      onPress={onPress}
      style={({ pressed, hovered }: Hovered) => [styles.tool, hovered ? styles.hover : null, pressed ? styles.pressed : null]}
    >
      {children}
    </Pressable>
  );
}

function Unread({ count, inline = false }: { count: number; inline?: boolean }) {
  if (count <= 0) return null;
  return (
    <View style={[styles.unread, inline ? styles.unreadInline : null]}>
      <Text style={styles.unreadText}>{count > 99 ? "99+" : String(count)}</Text>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    rail: {
      width: 84,
      backgroundColor: colors.bg,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.line,
      paddingTop: 10,
      paddingBottom: 14,
    },
    railOpen: { width: 280 },
    head: { alignItems: "center", paddingBottom: 8 },
    headOpen: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12 },
    headActions: { flexDirection: "row", gap: 6 },
    search: {
      marginHorizontal: 12,
      marginBottom: 8,
      height: 36,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: colors.control,
      color: colors.text,
      fontSize: 14,
      outlineWidth: 0,
    },
    list: { alignItems: "center", gap: 6, paddingBottom: 12 },
    listOpen: { alignItems: "stretch", gap: 2, paddingHorizontal: 8 },
    slot: { width: 62, height: 62, borderRadius: 16, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
    row: { flexDirection: "row", alignItems: "center", gap: 12, height: 64, paddingHorizontal: 10, borderRadius: 14, borderCurve: "continuous" },
    selected: { backgroundColor: colors.control },
    hover: { backgroundColor: colors.pressed },
    pressed: { opacity: 0.7 },
    face: { width: FACE, height: FACE, alignItems: "center", justifyContent: "center" },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
    title: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
    titleUnread: { fontWeight: "700" },
    label: { flexShrink: 1, maxWidth: 120, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    labelText: { color: colors.muted, fontSize: 11 },
    subtitle: { color: colors.muted, fontSize: 13 },
    subtitleWorking: { color: colors.online },
    empty: { color: colors.muted, fontSize: 13, textAlign: "center", paddingTop: 12 },
    working: {
      position: "absolute",
      right: -2,
      bottom: -2,
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: colors.online,
      borderWidth: 2,
      borderColor: colors.bg,
    },
    unread: {
      position: "absolute",
      right: -10,
      top: -10,
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 5,
      backgroundColor: colors.online,
      alignItems: "center",
      justifyContent: "center",
    },
    unreadInline: { position: "relative", right: 0, top: 0 },
    unreadText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
    foot: { alignItems: "center", gap: 8, paddingTop: 10 },
    footOpen: { alignItems: "stretch", paddingHorizontal: 8 },
    tool: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    account: { flexDirection: "row", alignItems: "center", gap: 10, padding: 5, borderRadius: 14 },
    accountOpen: { paddingHorizontal: 10 },
    accountName: { color: colors.text, fontSize: 14, flexShrink: 1 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
