import { randomSurpriseMark, type AgentMark } from "@kuru/shared";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { RosterAgent } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar } from "../ui/Avatar";
import { IconCheck } from "../ui/icons";
import { PrimaryButton } from "../ui/PrimaryButton";
import { pressableStyle } from "../ui/pressableStyles";

/**
 * Creates a direct chat or a group on the signed-in account.
 * Why: a new agent used to need a role, a job description, a provider and a
 * model id before it existed, which most people could not write. Now it needs
 * a look and a name: the agent asks what it is for and writes the rest itself,
 * or the default agent sets it up in conversation.
 * Input: the account's agents and the create handlers.
 * Output: the new-room form. The account id stays outside this form.
 */
export function NewRoomSheet({
  agents,
  onCreateChat,
  onCreateGroup,
  onAskSupport,
}: {
  agents: RosterAgent[];
  onCreateChat: (name: string, look: AgentMark) => Promise<void>;
  onCreateGroup: (title: string, agentIds: string[]) => Promise<void>;
  /** Opens the default agent's chat and asks it for a new agent, with the typed name if any. */
  onAskSupport?: (agent: RosterAgent, name: string) => Promise<void>;
}) {
  const support = agents.find((agent) => agent.kind === "support");
  const [kind, setKind] = useState<"chat" | "group">("chat");
  const [name, setName] = useState("");
  const [look, setLook] = useState<AgentMark>(() => randomSurpriseMark());
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<"create" | "ask" | "group" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chatReady = name.trim().length > 0;
  const groupReady = title.trim().length > 0 && picked.length >= 2;
  useResolvedScheme();

  /**
   * Toggles one agent in the group.
   * Input: the agent id.
   * Output: nothing. The picked list gains or loses that id.
   */
  function toggle(id: string): void {
    setPicked((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
  }

  return (
      <ScrollView
        // Fills a fixed-height sheet. Sizing the sheet to this form left the
        // bottom of it, the create button, outside the area that takes taps.
        style={{ flex: 1, backgroundColor: colors.sheet }}
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
          <View style={styles.kinds}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setKind("chat")}
              style={({ pressed }) => pressableStyle([styles.kind, kind === "chat" && styles.kindOn], { pressed })}
            >
              <Text style={[styles.kindText, kind === "chat" && styles.kindTextOn]}>Chat</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setKind("group")}
              style={({ pressed }) => pressableStyle([styles.kind, kind === "group" && styles.kindOn], { pressed })}
            >
              <Text style={[styles.kindText, kind === "group" && styles.kindTextOn]}>Group</Text>
            </Pressable>
          </View>
          {kind === "chat" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Change the look"
                onPress={() => setLook(randomSurpriseMark())}
                style={({ pressed }) => pressableStyle(styles.look, { pressed })}
              >
                <Avatar
                  id="new-agent"
                  size={104}
                  shape={look.markShape}
                  color={look.markColor}
                  material={look.markMaterial}
                  style={look.markStyle}
                  gender={look.markGender}
                />
                <Text style={styles.lookHint}>Tap for another look</Text>
              </Pressable>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Name"
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                style={styles.input}
              />
              <PrimaryButton
                label="Create"
                disabled={!chatReady || busy !== null}
                busy={busy === "create"}
                onPress={() => {
                  setBusy("create");
                  setError(null);
                  void onCreateChat(name.trim(), look)
                    .catch((failure: unknown) => {
                      setError(failure instanceof Error ? failure.message : "Could not create the chat.");
                    })
                    .finally(() => setBusy(null));
                }}
              />
              <Text style={styles.hint}>
                {name.trim() || "Your new agent"} will ask what you need help with, then set itself up.
              </Text>
              {support && onAskSupport ? (
                <>
                  <PrimaryButton
                    variant="secondary"
                    label={`Ask ${support.label || support.name} to set it up`}
                    disabled={busy !== null}
                    busy={busy === "ask"}
                    onPress={() => {
                      setBusy("ask");
                      setError(null);
                      void onAskSupport(support, name.trim())
                        .catch((failure: unknown) => {
                          setError(failure instanceof Error ? failure.message : "Could not open the chat.");
                        })
                        .finally(() => setBusy(null));
                    }}
                  />
                  <Text style={styles.hint}>Best for a bigger job or a team: it asks a few questions and writes the instructions.</Text>
                </>
              ) : null}
              {error && kind === "chat" ? <Text style={styles.error}>{error}</Text> : null}
            </>
          ) : (
            <>
              <TextInput value={title} onChangeText={setTitle} placeholder="Group name" placeholderTextColor={colors.muted} keyboardAppearance="dark" style={styles.input} />
              {agents.length < 2 ? <Text style={styles.hint}>Create at least two chats before a group.</Text> : null}
              {agents.filter((agent) => agent.kind !== "support" && agent.kind !== "companion").map((agent) => (
                <Pressable
                  key={agent.id}
                  accessibilityRole="button"
                  onPress={() => toggle(agent.id)}
                  style={({ pressed }) => pressableStyle(styles.agent, { pressed })}
                >
                  <Text style={styles.agentName}>{agent.name}</Text>
                  {picked.includes(agent.id) ? <IconCheck /> : null}
                </Pressable>
              ))}
              <PrimaryButton
                label="Create group"
                disabled={!groupReady}
                busy={busy === "group"}
                onPress={() => {
                  setBusy("group");
                  setError(null);
                  void onCreateGroup(title.trim(), picked)
                    .catch((failure: unknown) => {
                      const message = failure instanceof Error ? failure.message : "Could not create the group.";
                      setError(message);
                    })
                    .finally(() => setBusy(null));
                }}
              />
              {error && kind === "group" ? <Text style={styles.error}>{error}</Text> : null}
            </>
          )}
      </ScrollView>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  scrollContent: { padding: 14, paddingBottom: 28, gap: 10 },
  kinds: { flexDirection: "row", gap: 8 },
  kind: { flex: 1, height: 40, borderRadius: 14, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  kindOn: { backgroundColor: colors.text },
  kindText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  kindTextOn: { color: colors.bg },
  input: { backgroundColor: colors.card, color: colors.text, borderRadius: 14, height: 48, paddingHorizontal: 14, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 14, textAlign: "center" },
  look: { alignItems: "center", gap: 6, paddingVertical: 8 },
  lookHint: { color: colors.muted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 14 },
  agent: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 14, height: 48 },
  agentName: { color: colors.text, fontSize: 16, flex: 1 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
