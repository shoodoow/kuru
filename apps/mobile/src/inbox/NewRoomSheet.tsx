import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ProviderSetting, RosterAgent } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { IconCheck } from "../ui/icons";
import { PrimaryButton } from "../ui/PrimaryButton";
import { pressableStyle } from "../ui/pressableStyles";

/**
 * Creates a direct chat or a group on the signed-in account.
 * Why: hiring needs role + job up front (personality optional) so the agent
 * starts sharp instead of a vague blob.
 * Input: the account's agents and the create handlers.
 * Output: the new-room form. The account id stays outside this form.
 */
export function NewRoomSheet({
  agents,
  providers,
  defaultModel,
  onCreateChat,
  onCreateGroup,
  onAskSupport,
}: {
  /** The account's default model: the form starts on it. */
  defaultModel?: { provider: ProviderSetting["provider"]; modelId: string } | null;
  agents: RosterAgent[];
  providers: ProviderSetting[];
  onCreateChat: (
    name: string,
    role: string,
    jobDescription: string,
    provider: ProviderSetting["provider"],
    modelId: string,
    agentKind: "work" | "companion",
  ) => Promise<void>;
  onCreateGroup: (title: string, agentIds: string[]) => Promise<void>;
  /** Opens the default agent's chat, where it sets a new agent up by asking. */
  onAskSupport?: (agent: RosterAgent) => void | Promise<void>;
}) {
  const support = agents.find((agent) => agent.kind === "support");
  const [agentKind, setAgentKind] = useState<"work" | "companion">("work");
  const [kind, setKind] = useState<"chat" | "group">("chat");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [job, setJob] = useState("");
  const [provider, setProvider] = useState<ProviderSetting["provider"]>(defaultModel?.provider ?? "openai");
  const [modelId, setModelId] = useState(defaultModel?.modelId ?? "gpt-5");
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = providers.filter((row) => row.configured);
  // Why: the default is openai, but a fresh account may only have e.g.
  // anthropic or local configured — the button stayed disabled forever and
  // looked broken. Sync to the first configured provider when ours is missing.
  useEffect(() => {
    const available = providers.filter((row) => row.configured);
    if (available.length > 0 && !available.some((row) => row.provider === provider)) {
      setProvider(available[0]!.provider);
    }
  }, [providers, provider]);
  const chatReady =
    name.trim().length > 0 &&
    role.trim().length > 0 &&
    job.trim().length > 0 &&
    modelId.trim().length > 0 &&
    configured.some((row) => row.provider === provider);
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
              {support && onAskSupport ? (
                <>
                  <PrimaryButton label={`Ask ${support.label || support.name} to set one up`} onPress={() => void onAskSupport(support)} />
                  <Text style={styles.hint}>Or fill it in yourself:</Text>
                </>
              ) : null}
              <View style={styles.kinds}>
                {(["work", "companion"] as const).map((option) => (
                  <Pressable
                    key={option}
                    accessibilityRole="button"
                    onPress={() => setAgentKind(option)}
                    style={({ pressed }) => pressableStyle([styles.kind, agentKind === option && styles.kindOn], { pressed })}
                  >
                    <Text style={[styles.kindText, agentKind === option && styles.kindTextOn]}>
                      {option === "work" ? "Does work" : "Just to talk"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput value={name} onChangeText={setName} placeholder="Agent name" placeholderTextColor={colors.muted} keyboardAppearance="dark" style={styles.input} />
              <TextInput
                value={role}
                onChangeText={setRole}
                placeholder={agentKind === "work" ? "Role (e.g. Social manager)" : "Role (e.g. Spanish partner)"}
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                style={styles.input}
              />
              <TextInput
                value={job}
                onChangeText={setJob}
                placeholder={agentKind === "work" ? "What they do" : "What you want from talking with them"}
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                style={styles.input}
              />
              <Text style={styles.hint}>Provider</Text>
              <View style={styles.kinds}>
                {configured.map((row) => (
                  <Pressable
                    key={row.provider}
                    accessibilityRole="button"
                    onPress={() => setProvider(row.provider)}
                    style={({ pressed }) =>
                      pressableStyle([styles.kind, provider === row.provider && styles.kindOn], { pressed })
                    }
                  >
                    <Text style={[styles.kindText, provider === row.provider && styles.kindTextOn]}>{row.provider}</Text>
                  </Pressable>
                ))}
              </View>
              {configured.length === 0 ? <Text style={styles.hint}>Add an AI provider in the account menu first.</Text> : null}
              <TextInput
                value={modelId}
                onChangeText={setModelId}
                placeholder="Model id"
                placeholderTextColor={colors.muted}
                keyboardAppearance="dark"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <PrimaryButton
                label="Create chat"
                disabled={!chatReady}
                busy={busy}
                onPress={() => {
                  setBusy(true);
                  setError(null);
                  void onCreateChat(name.trim(), role.trim(), job.trim(), provider, modelId.trim(), agentKind)
                    .catch((failure: unknown) => {
                      const message = failure instanceof Error ? failure.message : "Could not create the chat.";
                      setError(message);
                    })
                    .finally(() => setBusy(false));
                }}
              />
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
                busy={busy}
                onPress={() => {
                  setBusy(true);
                  setError(null);
                  void onCreateGroup(title.trim(), picked)
                    .catch((failure: unknown) => {
                      const message = failure instanceof Error ? failure.message : "Could not create the group.";
                      setError(message);
                    })
                    .finally(() => setBusy(false));
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
  hint: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: 14 },
  agent: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 14, height: 48 },
  agentName: { color: colors.text, fontSize: 16, flex: 1 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
