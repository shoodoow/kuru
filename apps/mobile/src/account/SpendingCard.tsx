import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { AccountCredits } from "../api";
import { creditLine, dollars, runningLow } from "./spending";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { PrimaryButton } from "../ui/PrimaryButton";

/**
 * Money at the top of the Usage page: today's estimated spend against the
 * daily limit, what is left at each provider, and whether search works.
 * Why: agents work around the clock on prepaid credit. The person must see
 * the balance and set a limit before a bad day empties it, not after.
 */
export function SpendingCard({
  onLoad,
  onSaveLimit,
}: {
  onLoad: () => Promise<AccountCredits>;
  onSaveLimit: (usd: number | null) => Promise<unknown>;
}) {
  const [credits, setCredits] = useState<AccountCredits | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = () =>
    onLoad()
      .then((loaded) => {
        setCredits(loaded);
        setDraft(loaded.budget.limitUsd !== null ? String(loaded.budget.limitUsd) : "");
        setFailure(null);
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : "Balances did not load."));

  useEffect(() => {
    void load();
    // Loaded once when the page opens; saving the limit reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failure && !credits) return <Text style={styles.error}>{failure}</Text>;
  if (!credits) return null;
  const { budget } = credits;
  const parsed = draft.trim() === "" ? null : Number(draft.replace(",", "."));
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  const changed = valid && parsed !== budget.limitUsd;
  const share = budget.limitUsd ? Math.min(1, budget.spentUsd / budget.limitUsd) : 0;
  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <Text style={styles.title}>Spent today</Text>
        <Text style={styles.value}>
          {dollars(budget.spentUsd)}
          {budget.limitUsd !== null ? <Text style={styles.of}> of {dollars(budget.limitUsd)}</Text> : null}
        </Text>
      </View>
      {budget.limitUsd !== null ? (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.max(2, Math.round(share * 100))}%` }, share >= 0.8 && styles.fillHot]} />
        </View>
      ) : null}
      {budget.reached ? <Text style={styles.warn}>Limit reached: background jobs and scheduled runs are paused until tomorrow. Chats still answer.</Text> : null}
      {credits.outOfCredit ? <Text style={styles.warn}>A provider refused for lack of credit. Background work is paused for a while; add credit to go on.</Text> : null}
      <Text style={styles.label}>Daily limit in dollars (empty for no limit)</Text>
      <View style={styles.limitRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          keyboardType="decimal-pad"
          placeholder="No limit"
          placeholderTextColor={colors.muted}
          style={styles.input}
          accessibilityLabel="Daily spending limit in dollars"
        />
        <PrimaryButton label="Save" variant="secondary" disabled={!changed} onPress={() => onSaveLimit(parsed).then(load)} style={styles.save} />
      </View>
      {credits.providers.map((credit) => (
        <View key={credit.provider} style={styles.provider}>
          <Text style={styles.providerName}>{credit.service}</Text>
          <Text style={[styles.hint, runningLow(credit) && styles.warnText]}>{creditLine(credit)}</Text>
          {credit.note && creditLine(credit) !== credit.note ? <Text style={styles.hint}>{credit.note}</Text> : null}
        </View>
      ))}
      <View style={styles.provider}>
        <Text style={styles.providerName}>Web search</Text>
        <Text style={[styles.hint, (credits.search.provider === "none" || credits.search.down) && styles.warnText]}>
          {credits.search.down
            ? `Not working: ${credits.search.down}.`
            : credits.search.provider === "none"
              ? "No search key is set, and the free fallback is blocked. Add EXA_API_KEY or BRAVE_API_KEY on the server."
              : `Working through ${credits.search.provider === "exa" ? "Exa" : "Brave"}.`}
        </Text>
      </View>
      <Text style={styles.hint}>Dollars are estimated from list prices; your provider's bill is what counts.</Text>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: { backgroundColor: colors.card, borderRadius: 16, borderCurve: "continuous", padding: 14, gap: 8 },
    top: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
    title: { color: colors.muted, fontSize: 13 },
    value: { color: colors.text, fontSize: 24, fontWeight: "700", fontVariant: ["tabular-nums"] },
    of: { color: colors.muted, fontSize: 15, fontWeight: "500" },
    track: { height: 6, borderRadius: 3, backgroundColor: colors.control, overflow: "hidden" },
    fill: { height: 6, borderRadius: 3, backgroundColor: colors.online },
    fillHot: { backgroundColor: colors.danger },
    warn: { color: colors.danger, fontSize: 13, lineHeight: 18 },
    warnText: { color: colors.danger },
    label: { color: colors.muted, fontSize: 12, marginTop: 4 },
    limitRow: { flexDirection: "row", gap: 8, alignItems: "center" },
    input: { flex: 1, backgroundColor: colors.control, color: colors.text, borderRadius: 12, height: 44, paddingHorizontal: 12, fontSize: 16 },
    save: { minWidth: 88 },
    provider: { gap: 2, marginTop: 4 },
    providerName: { color: colors.text, fontSize: 15, fontWeight: "600" },
    hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
    error: { color: colors.danger, fontSize: 14 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
