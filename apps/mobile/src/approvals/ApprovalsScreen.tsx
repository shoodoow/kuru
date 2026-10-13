import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Proposal, ToolApproval } from "../api";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { pressableStyle } from "../ui/pressableStyles";
import { useNavBarPad } from "../ui/nav-bar-pad";

/**
 * Lists pending skill proposals and Auto-review tool rows.
 * Input: the pending lists and the decision handlers.
 * Output: the approvals screen.
 */
export function ApprovalsScreen({
  proposals,
  toolApprovals,
  onApprove,
  onReject,
  onApproveTool,
  onDenyTool,
  onBack: _onBack,
}: {
  proposals: Proposal[];
  toolApprovals: ToolApproval[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onApproveTool: (id: string) => void;
  onDenyTool: (id: string) => void;
  onBack: () => void;
}) {
  const empty = proposals.length === 0 && toolApprovals.length === 0;
  const navBarPad = useNavBarPad();
  return (
    <View style={[styles.screen, navBarPad]}>
      <ScrollView contentContainerStyle={styles.list} contentInsetAdjustmentBehavior="automatic">
        {empty ? <Text style={styles.empty}>Nothing to review.</Text> : null}
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
  empty: { color: colors.muted, textAlign: "center", marginTop: 48, fontSize: 16 },
  card: { backgroundColor: colors.bubble, borderRadius: 22, padding: 16 },
  kind: { color: colors.muted, fontSize: 13, marginBottom: 6 },
  body: { color: colors.text, fontSize: 16, lineHeight: 24 },
  actions: { flexDirection: "row", gap: 12, marginTop: 14 },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  actionText: { color: colors.link, fontSize: 16, fontWeight: "600" },
  rejectText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
