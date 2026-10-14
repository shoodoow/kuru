import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { InboxStatus, RosterAgent } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar } from "../ui/Avatar";
import { useNavBarPad } from "../ui/nav-bar-pad";
import { GroupCluster, type GroupFace } from "../ui/GroupCluster";
import { IconPin, IconEyeOff, IconReply } from "../ui/icons";

/**
 * Shows the account roster plus group rooms in a chat-list layout.
 * Why: groups previously vanished after creation — agents alone cannot
 * reopen them. The groups section lists every group room with member counts.
 * Each row also shows whether its agent is working (a blue dot on the avatar)
 * and how many of its messages are unread, so nobody has to open a chat to find out.
 * Input: agents, groups, their status, and handlers for account, search, new chat,
 * opening one agent, and opening one group.
 * Output: the inbox screen.
 */
export function InboxScreen({
  agents,
  groups,
  status,
  searching,
  onOpen,
  onOpenGroup,
  onPin,
  onHide,
  onRefresh,
  note,
}: {
  /** Reads the list again from the server; pulling the list down calls it. */
  onRefresh?: () => Promise<void>;
  agents: RosterAgent[];
  groups: { id: string; title: string; memberCount: number; members: GroupFace[] }[];
  /** Unread counts and busy agents; null until first loaded. */
  status: InboxStatus | null;
  searching: boolean;
  onOpen: (agent: RosterAgent) => void;
  onOpenGroup: (conversationId: string) => void;
  onPin: (agent: RosterAgent) => void;
  onHide: (agent: RosterAgent) => void;
  note?: string;
}) {
  useResolvedScheme();
  const [query, setQuery] = useState("");
  const visible = useMemo(() => agents.filter((agent) => !agent.hidden), [agents]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return visible;
    }
    return visible.filter((agent) => `${agent.name} ${agent.label} ${agent.role} ${agent.jobDescription}`.toLowerCase().includes(needle));
  }, [query, visible]);
  const [held, setHeld] = useState<RosterAgent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const navBarPad = useNavBarPad();
  const marks = useMemo(() => {
    const working = new Set(status?.workingAgentIds ?? []);
    const unreadByAgent = new Map<string, number>();
    const rooms = new Map<string, { unread: number; working: boolean }>();
    for (const room of status?.rooms ?? []) {
      rooms.set(room.id, room);
      if (room.kind === "direct") {
        unreadByAgent.set(room.ownerAgentId, (unreadByAgent.get(room.ownerAgentId) ?? 0) + room.unread);
      }
    }
    return {
      agent: (id: string) => ({ working: working.has(id), unread: unreadByAgent.get(id) ?? 0 }),
      group: (id: string) => rooms.get(id) ?? { working: false, unread: 0 },
    };
  }, [status]);
  // The Chief of Staff is always pinned, and first.
  const isPinned = (agent: RosterAgent): boolean => agent.pinned || agent.kind === "support";
  const pinned = query.trim()
    ? []
    : filtered.filter(isPinned).sort((left, right) => Number(right.kind === "support") - Number(left.kind === "support"));
  const rows = query.trim() ? filtered : filtered.filter((agent) => !isPinned(agent));

  return (
    <View style={styles.screen}>
      {searching ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          style={styles.search}
        />
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(agent) => agent.id}
        contentContainerStyle={[styles.list, navBarPad ? { paddingBottom: 32 + navBarPad.paddingBottom } : null]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.muted}
              onRefresh={() => {
                setRefreshing(true);
                void onRefresh()
                  .catch(() => {})
                  .finally(() => setRefreshing(false));
              }}
            />
          ) : undefined
        }
        ListHeaderComponent={
          <>
            {pinned.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pinnedRow}>
                {pinned.map((agent) => (
                  <Pressable
                    key={agent.id}
                    accessibilityRole="button"
                    accessibilityLabel={rowLabel(`Pinned ${agent.name}`, marks.agent(agent.id))}
                    onPress={() => onOpen(agent)}
                    onLongPress={() => setHeld(agent)}
                    delayLongPress={350}
                    style={styles.pinnedItem}
                  >
                    <PinnedFace agent={agent} working={marks.agent(agent.id).working} unread={marks.agent(agent.id).unread} />
                    <Text style={styles.pinnedLabel} numberOfLines={1}>
                      {agent.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            {agents.length === 0 ? (
              <Text style={styles.empty}>No chats yet. Pull down to load them again.</Text>
            ) : filtered.length === 0 ? (
              <Text style={styles.empty}>No matching agents.</Text>
            ) : null}
          </>
        }
        ListFooterComponent={
          groups.length > 0 ? (
            <View style={styles.groups}>
              <Text style={styles.groupsTitle}>Groups</Text>
              {groups.map((group) => {
                const mark = marks.group(group.id);
                return (
                  <Pressable
                    key={group.id}
                    accessibilityRole="button"
                    accessibilityLabel={rowLabel(group.title, mark)}
                    onPress={() => onOpenGroup(group.id)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <View>
                      <GroupCluster members={group.members} size={36} />
                      {mark.working ? <View style={styles.workingDot} /> : null}
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={[styles.name, mark.unread > 0 && styles.nameUnread]} numberOfLines={1}>
                        {group.title}
                      </Text>
                      <Text style={[styles.preview, mark.working && styles.workingText]} numberOfLines={1}>
                        {mark.working ? "Working…" : `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}`}
                      </Text>
                    </View>
                    <UnreadBadge count={mark.unread} />
                  </Pressable>
                );
              })}
            </View>
          ) : null
        }
        extraData={marks}
        renderItem={({ item }) => {
          const mark = marks.agent(item.id);
          return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={rowLabel(item.name, mark)}
            onPress={() => onOpen(item)}
            onLongPress={() => setHeld(item)}
            delayLongPress={350}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View>
              <Avatar
                id={item.id}
                size={46}
                round={item.name.length % 2 === 0}
                shape={item.markShape}
                color={item.markColor}
                material={item.markMaterial}
                style={item.markStyle}
                gender={item.markGender}
                photo={item.avatarUrl}
                mood={mark.working ? "working" : "idle"}
              />
              {mark.working ? <View style={styles.workingDot} /> : null}
            </View>
            <View style={styles.rowBody}>
              <View style={styles.rowTop}>
                <Text style={[styles.name, mark.unread > 0 && styles.nameUnread]} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.label && item.label !== item.name ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{item.label}</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.previewRow}>
                {mark.working ? null : <IconReply />}
                <Text style={[styles.preview, mark.working && styles.workingText]} numberOfLines={1}>
                  {mark.working ? "Working…" : item.role || `Message ${item.name}`}
                </Text>
              </View>
            </View>
            <UnreadBadge count={mark.unread} />
          </Pressable>
          );
        }}
      />
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <Modal visible={held !== null} transparent animationType="fade" onRequestClose={() => setHeld(null)}>
        <Pressable accessibilityLabel="Dismiss" style={styles.scrim} onPress={() => setHeld(null)}>
          {held ? (
            <Pressable style={styles.holdCard} onPress={() => {}}>
              <View style={styles.holdPreview}>
                <Avatar
                  id={held.id}
                  size={28}
                  shape={held.markShape}
                  color={held.markColor}
                  material={held.markMaterial}
                  style={held.markStyle}
                  gender={held.markGender}
                  photo={held.avatarUrl}
                />
                <Text style={styles.holdName} numberOfLines={1}>{held.name}</Text>
              </View>
              <Text style={styles.holdBody} numberOfLines={4}>{held.role || `Message ${held.name}`}</Text>
              <View style={styles.holdMenu}>
                {held.kind !== "support" ? (
                <>
                <Pressable
                  accessibilityRole="button"
                  style={styles.holdRow}
                  onPress={() => {
                    const agent = held;
                    setHeld(null);
                    onPin(agent);
                  }}
                >
                  <IconPin />
                  <Text style={styles.holdLabel}>{held.pinned ? "Unpin" : "Pin"}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={styles.holdRow}
                  onPress={() => {
                    const agent = held;
                    setHeld(null);
                    onHide(agent);
                  }}
                >
                  <IconEyeOff />
                  <Text style={[styles.holdLabel, styles.holdDanger]}>Hide</Text>
                </Pressable>
                </>
                ) : null}
              </View>
            </Pressable>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const PIN_BOX = 76;
/** Draws one pinned face inside the same square, whatever the mark shape is. */
function PinnedFace({ agent, working, unread }: { agent: RosterAgent; working: boolean; unread: number }) {
  return (
    <View style={styles.pinnedFace}>
      {working ? <View style={[styles.workingDot, styles.pinnedDot]} /> : null}
      {unread > 0 ? (
        <View style={styles.pinnedBadge}>
          <UnreadBadge count={unread} />
        </View>
      ) : null}
      <Avatar
        id={agent.id}
        size={PIN_BOX}
        shape={agent.markShape}
        color={agent.markColor}
        material={agent.markMaterial}
        style={agent.markStyle}
        gender={agent.markGender}
        photo={agent.avatarUrl}
        mood={working ? "working" : "idle"}
      />
    </View>
  );
}

/** A count of messages the person has not seen; nothing when there are none. */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.unread}>
      <Text style={styles.unreadText}>{count > 99 ? "99+" : String(count)}</Text>
    </View>
  );
}

/** What a screen reader says for a row: the name, then anything the marks show. */
function rowLabel(name: string, mark: { working: boolean; unread: number }): string {
  return [name, mark.working ? "working" : "", mark.unread > 0 ? `${mark.unread} unread` : ""].filter(Boolean).join(", ");
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8 },
  account: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", gap: 4, alignItems: "center" },
  pingBadge: { backgroundColor: colors.danger, borderRadius: 11, minWidth: 22, height: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  pingText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  menu: { position: "absolute", top: 60, left: 8, right: 8, bottom: 12 },
  iosSheet: { flex: 1, backgroundColor: colors.sheet },
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: colors.bubble,
    color: colors.text,
    borderRadius: 18,
    paddingHorizontal: 16,
    height: 44,
    fontSize: 16,
  },
  list: { paddingTop: 8, paddingBottom: 32 },
  groups: { marginTop: 8 },
  groupsTitle: { color: colors.muted, fontSize: 13, fontWeight: "700", textTransform: "uppercase", paddingHorizontal: 16, marginBottom: 4 },
  pinnedRow: { gap: 8, paddingTop: 28, paddingBottom: 16, paddingHorizontal: 16, flexGrow: 1, justifyContent: "center" },
  pinnedItem: { width: 108, alignItems: "center", gap: 8 },
  pinnedFace: { width: 108, height: 76, alignItems: "center", justifyContent: "center" },
  pinnedLabel: { color: colors.text, fontSize: 13, textAlign: "center" },
  empty: { color: colors.muted, textAlign: "center", marginTop: 80, fontSize: 16, paddingHorizontal: 32 },
  note: { color: colors.danger, position: "absolute", left: 20, right: 20, bottom: 24, fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  pressed: { opacity: 0.6 },
  rowBody: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  nameUnread: { fontWeight: "800" },
  workingText: { color: colors.online },
  workingDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.online,
    borderWidth: 2,
    borderColor: colors.bg,
    zIndex: 1,
  },
  pinnedDot: { right: 14, bottom: 0 },
  pinnedBadge: { position: "absolute", right: 8, top: -4, zIndex: 1 },
  unread: { backgroundColor: colors.online, borderRadius: 11, minWidth: 22, height: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  unreadText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  badge: { backgroundColor: colors.control, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: colors.muted, fontSize: 13 },
  previewRow: { flexDirection: "row", alignItems: "center" },
  preview: { color: colors.muted, fontSize: 15, flex: 1 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", paddingHorizontal: 36 },
  holdCard: { gap: 10 },
  holdPreview: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", backgroundColor: colors.control, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  holdName: { color: colors.text, fontSize: 16, fontWeight: "600", maxWidth: 180 },
  holdBody: { color: colors.text, fontSize: 15, lineHeight: 20, backgroundColor: colors.control, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  holdMenu: { backgroundColor: colors.control, borderRadius: 16, overflow: "hidden", marginTop: 4 },
  holdRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  holdLabel: { color: colors.text, fontSize: 16 },
  holdDanger: { color: colors.danger },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
