import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Proposal, ToolAllowance, ToolApproval } from "../api";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { pressableStyle } from "../ui/pressableStyles";
import { useNavBarPad } from "../ui/nav-bar-pad";

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
  onBack: _onBack,
}: {
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
            <Text style={styles.kind}>{row.tool}</Text>
            <Text style={styles.body}>{row.summary}</Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onApproveTool(row.id)}
                style={(state) => pressableStyle(styles.action, state)}
              >
                <Text style={styles.actionText}>Approve</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onDenyTool(row.id)}
                style={(state) => pressableStyle(styles.action, state)}
              >
                <Text style={styles.rejectText}>Deny</Text>
              </Pressable>
              {row.canAlwaysAllow ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onApproveTool(row.id, true)}
                  style={(state) => pressableStyle(styles.action, state)}
                >
                  <Text style={styles.actionText}>Always allow</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}
        {proposals.map((proposal) => (
          <View key={proposal.id} style={styles.card}>
            <Text style={styles.kind}>{proposal.kind}</Text>
            <Text style={styles.body}>{proposal.body}</Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => onApprove(proposal.id)}
                style={(state) => pressableStyle(styles.action, state)}
              >
                <Text style={styles.actionText}>Approve</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onReject(proposal.id)}
                style={(state) => pressableStyle(styles.action, state)}
              >
                <Text style={styles.rejectText}>Reject</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Text style={styles.section}>Allowed without asking</Text>
        <Text style={styles.quiet}>
          {allowances.length > 0
            ? "These agents take these actions without asking. Tap Ask again to need your approval each time."
            : "Nothing yet. Choose Always allow on an approval, and that agent stops asking for that action."}
        </Text>
        {allowances.map((row) => (
          <View key={row.id} style={styles.allowRow}>
            <View style={styles.allowBody}>
              <Text style={styles.body}>{row.label}</Text>
              <Text style={styles.kind}>{row.agentName}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Ask again before ${row.agentName}: ${row.label}`}
              onPress={() => void onRemoveAllowance(row.id).then(setAllowances).catch(() => {})}
              style={(state) => pressableStyle(styles.action, state)}
            >
              <Text style={styles.rejectText}>Ask again</Text>
            </Pressable>
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
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  spacer: { width: 44 },
  list: { padding: 16, gap: 12 },
  card: { backgroundColor: colors.bubble, borderRadius: 22, padding: 16 },
  kind: { color: colors.muted, fontSize: 13, marginBottom: 6 },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  actions: { flexDirection: "row", gap: 12, marginTop: 14 },
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
