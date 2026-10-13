import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { RosterAgent } from "../api";
import { useSession } from "../session/SessionProvider";
import { useResolvedScheme } from "../theme/appearance";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { GroupCluster } from "../ui/GroupCluster";
import { IconPlus } from "../ui/icons";

const FACE = 44;

/**
 * The column of agents down the left edge of the desktop window.
 * It is the chat list of the phone, reduced to faces: pinned agents first,
 * then the rest, then groups. A blue dot means the agent is working and a
 * count means unread messages. Under them are New chat and the account.
 * Input: none; it reads the session. Output: the rail.
 */
export function AgentRail() {
  useResolvedScheme();
  const session = useSession();
  const openId = session.conversationId ? session.lastChat?.conversationId : null;
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
  const agents = useMemo(() => {
    const shown = session.agents.filter((agent) => !agent.hidden);
    return [...shown.filter((agent) => agent.pinned), ...shown.filter((agent) => !agent.pinned)];
  }, [session.agents]);
  const openAgentId = session.lastChat?.kind === "direct" && openId ? session.lastChat.agent.id : null;

  if (!session.account || session.setupNeeded) return null;
  return (
    <View style={styles.rail}>
      <ScrollView contentContainerStyle={styles.faces} showsVerticalScrollIndicator={false}>
        {agents.map((agent) => (
          <Face
            key={agent.id}
            agent={agent}
            selected={agent.id === openAgentId}
            working={marks.working.has(agent.id)}
            unread={marks.unread.get(agent.id) ?? 0}
            onPress={() => void session.openAgent(agent).catch(session.show)}
          />
        ))}
        {session.groups.map((group) => {
          const mark = marks.rooms.get(group.id);
          return (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              accessibilityLabel={group.title}
              // The browser shows this as a tooltip on hover.
              {...({ title: group.title } as object)}
              onPress={() => void session.openGroup(group.id).catch(session.show)}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                styles.slot,
                group.id === openId ? styles.slotOn : hovered ? styles.slotHover : null,
                pressed ? styles.slotPressed : null,
              ]}
            >
              <GroupCluster members={group.members.slice(0, 2)} size={26} />
              {mark?.working ? <View style={styles.working} /> : null}
              <Unread count={mark?.unread ?? 0} />
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.foot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          {...({ title: "New chat" } as object)}
          onPress={() => session.openNewRoom()}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.tool,
            hovered ? styles.slotHover : null,
            pressed ? styles.slotPressed : null,
          ]}
        >
          <IconPlus />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account"
          {...({ title: "Account" } as object)}
          onPress={() => session.openAccount("menu")}
          style={({ pressed }) => [styles.tool, pressed ? styles.slotPressed : null]}
        >
          <Avatar id={session.account.id} size={34} person label={session.account.name} photo={session.account.image} />
        </Pressable>
      </View>
    </View>
  );
}

function Face({
  agent,
  selected,
  working,
  unread,
  onPress,
}: {
  agent: RosterAgent;
  selected: boolean;
  working: boolean;
  unread: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[agent.name, working ? "working" : "", unread > 0 ? `${unread} unread` : ""].filter(Boolean).join(", ")}
      accessibilityState={{ selected }}
      {...({ title: agent.name } as object)}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.slot,
        selected ? styles.slotOn : hovered ? styles.slotHover : null,
        pressed ? styles.slotPressed : null,
      ]}
    >
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
      {working ? <View style={styles.working} /> : null}
      <Unread count={unread} />
    </Pressable>
  );
}

function Unread({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.unread}>
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
      paddingTop: 14,
      paddingBottom: 14,
      alignItems: "center",
    },
    faces: { alignItems: "center", gap: 6, paddingBottom: 12 },
    slot: { width: 62, height: 62, borderRadius: 16, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
    slotOn: { backgroundColor: colors.control },
    slotHover: { backgroundColor: colors.pressed },
    slotPressed: { opacity: 0.7 },
    working: {
      position: "absolute",
      right: 8,
      bottom: 8,
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: colors.online,
      borderWidth: 2,
      borderColor: colors.bg,
    },
    unread: {
      position: "absolute",
      right: 4,
      top: 4,
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 5,
      backgroundColor: colors.online,
      alignItems: "center",
      justifyContent: "center",
    },
    unreadText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] },
    foot: { alignItems: "center", gap: 8, paddingTop: 10 },
    tool: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
