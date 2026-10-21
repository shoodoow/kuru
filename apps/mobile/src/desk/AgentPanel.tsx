import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { createCore } from "../api";
import { BotInfoScreen } from "../chat/BotInfoScreen";
import { DesktopScreen } from "../desktop/DesktopScreen";
import { useSession, type ChatTarget } from "../session/SessionProvider";
import { useResolvedScheme } from "../theme/appearance";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconClose } from "../ui/icons";

const core = createCore();

/**
 * The panel beside a chat in the desktop window: the agent's details, and its
 * computer screen.
 * Details is the same profile page the phone opens over the chat (name, look,
 * instructions, routines, and the links, media and files it has shared).
 * Computer shows the agent's screen as it works; it only watches, so the
 * agent keeps its mouse. Clicking the screen opens it full size to take over.
 * Input: the open chat. Output: the panel, or nothing while it is closed.
 */
export function AgentPanel({ chat }: { chat: ChatTarget }) {
  useResolvedScheme();
  const session = useSession();
  const panel = session.sidePanel;
  const agentId = chat.kind === "direct" ? chat.agent.id : null;
  // Another agent picked with the panel open: load its profile, media, links and files.
  useEffect(() => {
    if (panel && agentId && session.profile?.id !== agentId && chat.kind === "direct") session.loadProfile(chat.agent);
    // Runs when the agent or the panel changes, not on every profile edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, agentId]);
  if (!panel || chat.kind !== "direct") return null;
  const profile = session.profile?.id === chat.agent.id ? session.profile : chat.agent;
  const hasComputer = Boolean(chat.agent.linuxProfile);
  const shown = panel === "computer" && !hasComputer ? "details" : panel;
  return (
    <View style={styles.panel}>
      <View style={styles.bar}>
        <View style={styles.tabs}>
          <Tab label="Details" on={shown === "details"} onPress={() => session.setSidePanel("details")} />
          {hasComputer ? <Tab label="Computer" on={shown === "computer"} onPress={() => session.setSidePanel("computer")} /> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close panel"
          onPress={() => session.setSidePanel(null)}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.close,
            hovered ? styles.closeHover : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <IconClose />
        </Pressable>
      </View>
      {shown === "details" ? (
        <BotInfoScreen
          embedded
          profile={profile}
          providers={session.providers}
          routines={session.routines}
          onChange={(next) => session.setProfile(next)}
          onSave={() => session.saveProfile().catch(session.show)}
          onSaveNotify={(draft) => void session.saveProfile(draft).catch(session.show)}
          onBack={() => session.setSidePanel(null)}
          onApprovals={() => void session.refreshProposals().catch(session.show)}
          onPickAvatar={() => void session.pickAvatar().catch(session.show)}
          onPauseRoutine={(routine, paused) => void session.pauseRoutine(routine, paused).catch(session.show)}
          onLoadRoutineRuns={(routineId) => core.listRoutineRuns(session.accountId.trim(), profile.id, routineId)}
          messages={session.profileFeed}
          onFetchBlob={(roomId, messageId, index) => core.blob(session.accountId.trim(), roomId, messageId, index)}
          health={{
            load: () => core.agentHealth(session.accountId.trim(), profile.id),
            fix: () => core.reflectNow(session.accountId.trim(), profile.id),
            undo: (reflectionId) => core.undoReflection(session.accountId.trim(), profile.id, reflectionId),
          }}
          work={{
            running: () => core.agentRunning(session.accountId.trim(), profile.id),
            stop: (workerId) => core.stopAgentJob(session.accountId.trim(), profile.id, workerId),
            memories: () => core.agentMemories(session.accountId.trim(), profile.id),
            forget: (memoryId) => core.forgetMemory(session.accountId.trim(), profile.id, memoryId),
            forgetAll: () => core.forgetAllMemories(session.accountId.trim(), profile.id),
          }}
        />
      ) : (
        <View style={styles.computer}>
          <View style={styles.screen}>
            <DesktopScreen
              embedded
              accountId={session.accountId.trim()}
              agent={chat.agent}
              onBack={() => {}}
              onApprovals={() => {}}
              onError={session.show}
              onExpand={() => session.openDesktop(chat.agent)}
            />
          </View>
          <Text style={styles.caption}>{chat.agent.name}'s screen · click to take control</Text>
        </View>
      )}
    </View>
  );
}

function Tab({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.tab, on ? styles.tabOn : hovered ? styles.closeHover : null]}
    >
      <Text style={[styles.tabText, on ? styles.tabTextOn : null]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    panel: {
      width: 420,
      backgroundColor: colors.bg,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.line,
    },
    bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, height: 56 },
    tabs: { flexDirection: "row", gap: 4 },
    tab: { paddingHorizontal: 12, height: 32, borderRadius: 10, justifyContent: "center" },
    tabOn: { backgroundColor: colors.control },
    tabText: { color: colors.muted, fontSize: 14 },
    tabTextOn: { color: colors.text, fontWeight: "600" },
    close: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.control },
    closeHover: { backgroundColor: colors.pressed },
    pressed: { opacity: 0.7 },
    computer: { flex: 1, padding: 14, gap: 10 },
    // The agent's screen is 4:3 or wider; this keeps the frame from collapsing while it connects.
    screen: { aspectRatio: 16 / 10, borderRadius: 14, borderCurve: "continuous", overflow: "hidden", backgroundColor: "#111" },
    caption: { color: colors.muted, fontSize: 13, textAlign: "center" },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
