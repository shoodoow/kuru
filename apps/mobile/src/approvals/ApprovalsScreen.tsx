import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Proposal, RosterAgent, ToolAllowance, ToolApproval } from "../api";
import { Avatar } from "../ui/Avatar";
import { IconTrash } from "../ui/icons";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { pressableStyle } from "../ui/pressableStyles";
import { useNavBarPad } from "../ui/nav-bar-pad";

/** "Oct 14" or "today 09:12", for when something was asked or allowed. */
function when(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === new Date().toDateString()) {
    return `today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The agent's own face and name, as in the chat list. */
function Who({ agentId, name, agents, detail }: { agentId: string; name: string; agents?: RosterAgent[]; detail: string }) {
  const face = agents?.find((row) => row.id === agentId);
  return (
    <View style={styles.who}>
      <Avatar
        id={agentId}
        size={32}
        label={name}
        shape={face?.markShape ?? null}
        color={face?.markColor ?? null}
        material={face?.markMaterial ?? null}
        style={face?.markStyle ?? null}
        gender={face?.markGender ?? null}
        photo={face?.avatarUrl ?? null}
      />
      <View style={styles.whoText}>
        <Text style={styles.whoName} numberOfLines={1}>{face?.label || face?.name || name}</Text>
        {detail ? <Text style={styles.whoDetail} numberOfLines={1}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/**
 * Lists pending skill proposals and Auto-review tool rows, and the actions
 * agents may take without asking ("Always allow"), each of which can be taken back.
 * Input: the pending lists, the decision handlers, and the allowance loaders.
 * Output: the approvals screen.
 */
export function ApprovalsScreen({
  proposals,
  toolApprovals,
  onApprove,
  onReject,
  onApproveTool,
  onDenyTool,
  onReload,
  onLoadAllowances,
  onRemoveAllowance,
  agents,
  onBack: _onBack,
}: {
  /** For each agent's face and name on its cards. */
  agents?: RosterAgent[];
  proposals: Proposal[];
  toolApprovals: ToolApproval[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  /** `always`: that agent may take this action from now on without asking. */
  onApproveTool: (id: string, always?: boolean) => void;
  onDenyTool: (id: string) => void;
  /** Reloads what is waiting; throws when it cannot. */
  onReload: () => Promise<void>;
  onLoadAllowances: () => Promise<ToolAllowance[]>;
  onRemoveAllowance: (id: string) => Promise<ToolAllowance[]>;
  onBack: () => void;
}) {
  const [allowances, setAllowances] = useState<ToolAllowance[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  // Everything on the page loads here, after it opened, and a failure is said on the page.
  const load = (): Promise<void> => {
    setFailed(null);
    return Promise.all([onReload(), onLoadAllowances().then(setAllowances)])
      .then(() => undefined)
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : "Approvals did not load."))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Reloaded when a decision changes the pending list, since "Always allow" adds one.
  useEffect(() => {
    void onLoadAllowances()
      .then(setAllowances)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolApprovals.length]);
  const nothingWaiting = proposals.length === 0 && toolApprovals.length === 0;
  const navBarPad = useNavBarPad();
  return (
    <View style={[styles.screen, navBarPad]}>
      <ScrollView
        contentContainerStyle={styles.list}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      >
        {failed ? <Text style={styles.failed}>{failed} Pull down to try again.</Text> : null}
        {loading ? <ActivityIndicator style={styles.loading} /> : null}
        <Text style={styles.section}>Waiting for you</Text>
        {nothingWaiting && !loading ? <Text style={styles.quiet}>Nothing is waiting for your approval.</Text> : null}
        {toolApprovals.map((row) => (
          <View key={row.id} style={styles.card}>
            <Who agentId={row.agentId} name={row.agentName ?? "An agent"} agents={agents} detail={`Asks ${when(row.createdAt) || "now"}`} />
            <Text style={styles.title}>{row.action ?? row.tool}</Text>
            <Text style={styles.body}>{row.summary}</Text>
            <Text style={styles.note}>
              {row.canAlwaysAllow
                ? "It waits until you decide. Always allow lets this agent do this again without asking."
                : "It waits until you decide. This kind of action asks every time."}
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onApproveTool(row.id)}
                style={(state) => pressableStyle([styles.button, styles.primary], state)}
              >
                <Text style={styles.primaryText}>Approve</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onDenyTool(row.id)}
                style={(state) => pressableStyle(styles.button, state)}
              >
                <Text style={styles.rejectText}>Deny</Text>
              </Pressable>
            </View>
            {row.canAlwaysAllow ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => onApproveTool(row.id, true)}
                style={(state) => pressableStyle(styles.always, state)}
              >
                <Text style={styles.actionText}>Always allow</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {proposals.map((proposal) => (
          <View key={proposal.id} style={styles.card}>
            <Text style={styles.title}>{proposal.kind === "skill" ? "A new skill" : proposal.kind.charAt(0).toUpperCase() + proposal.kind.slice(1)}</Text>
            <Text style={styles.body}>{proposal.body}</Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onApprove(proposal.id)}
                style={(state) => pressableStyle([styles.button, styles.primary], state)}
              >
                <Text style={styles.primaryText}>Approve</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onReject(proposal.id)}
                style={(state) => pressableStyle(styles.button, state)}
              >
                <Text style={styles.rejectText}>Reject</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Text style={styles.section}>Allowed without asking</Text>
        <Text style={styles.quiet}>
          {allowances.length > 0
            ? "These agents do these actions without asking you. Delete one and that agent asks you again each time."
            : "Nothing yet. Choose Always allow on an approval, and that agent stops asking for that action."}
        </Text>
        {allowances.map((row) => (
          <View key={row.id} style={styles.card}>
            <View style={styles.allowHead}>
              <Who agentId={row.agentId} name={row.agentName} agents={agents} detail={`Allowed ${when(row.createdAt)}`} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete: ${row.agentName} may ${row.label.toLowerCase()} without asking`}
                hitSlop={8}
                onPress={() =>
                  Alert.alert(
                    "Delete this permission?",
                    `${row.agentName} will ask you again before it does this: ${row.label.toLowerCase()}.`,
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => void onRemoveAllowance(row.id).then(setAllowances).catch(() => {}),
                      },
                    ],
                  )
                }
                style={(state) => pressableStyle(styles.trash, state)}
              >
                <IconTrash />
              </Pressable>
            </View>
            <Text style={styles.title}>{row.label}</Text>
            <Text style={styles.note}>{row.agentName} does this without asking you first. You still see it in the chat.</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 },
  spacer: { width: 44 },
  list: { padding: 16, gap: 12 },
  card: { backgroundColor: colors.bubble, borderRadius: 22, borderCurve: "continuous", padding: 16, gap: 8 },
  who: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  whoText: { flex: 1, gap: 1 },
  whoName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  whoDetail: { color: colors.muted, fontSize: 13 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: 4 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  button: { flex: 1, minHeight: 44, borderRadius: 14, borderCurve: "continuous", backgroundColor: colors.control, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.online },
  primaryText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  always: { minHeight: 40, alignItems: "center", justifyContent: "center" },
  allowHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  trash: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.control, alignItems: "center", justifyContent: "center" },
  kind: { color: colors.muted, fontSize: 13, marginBottom: 6 },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  actions: { flexDirection: "row", gap: 10, marginTop: 6 },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  actionText: { color: colors.link, fontSize: 16, fontWeight: "600" },
  rejectText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  section: { color: colors.text, fontSize: 15, fontWeight: "600", marginTop: 8, marginLeft: 4 },
  quiet: { color: colors.muted, fontSize: 14, lineHeight: 20, marginHorizontal: 4 },
  failed: { color: colors.danger, fontSize: 14, lineHeight: 20, marginHorizontal: 4 },
  loading: { marginVertical: 12 },
  allowRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.bubble, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  allowBody: { flex: 1, gap: 2 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
