import { chartValue } from "@kuru/shared";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { AccountCredits, AccountUsage, RosterAgent, UsagePeriod } from "../api";
import { SpendingCard } from "./SpendingCard";
import { dollars } from "./spending";
import { modelColor, modelName, UsageChart } from "./UsageChart";
import { providerLabel } from "./ModelsPage";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { pressableStyle } from "../ui/pressableStyles";

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "This month" },
];

/**
 * What the account's agents used: tokens, turns and background jobs, by hour
 * or day, by model and by agent.
 * Why: the ring in a chat covers one conversation. This is the whole account,
 * so the person can see how much is being spent, on which model and by which
 * agent. Dollars are estimates from list prices; balances and the daily limit
 * sit at the top, when the server offers them.
 * Input: the roster (for faces), a loader for one period, and optionally the
 * balance loader and the limit setter. Output: the page.
 */
export function UsagePage({
  agents,
  onLoad,
  onLoadCredits,
  onSaveLimit,
  scrollStyle,
}: {
  agents: RosterAgent[];
  onLoad: (period: UsagePeriod) => Promise<AccountUsage>;
  onLoadCredits?: () => Promise<AccountCredits>;
  onSaveLimit?: (usd: number | null) => Promise<unknown>;
  scrollStyle: ViewStyle;
}) {
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    onLoad(period)
      .then((loaded) => {
        if (current) setUsage(loaded);
      })
      .catch((failure: unknown) => {
        if (current) setError(failure instanceof Error ? failure.message : "Usage did not load.");
      });
    return () => {
      current = false;
    };
    // The loader is recreated on every render of the menu; the period is what changes the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  const shown = usage?.period === period ? usage : null;
  const total = shown ? shown.totals.inputTokens + shown.totals.outputTokens : 0;
  const most = Math.max(1, ...(shown?.agents.map((row) => row.inputTokens + row.outputTokens) ?? []));
  const label = PERIODS.find((entry) => entry.id === period)!.label.toLowerCase();
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {onLoadCredits && onSaveLimit ? <SpendingCard onLoad={onLoadCredits} onSaveLimit={onSaveLimit} /> : null}
      <View style={styles.periods}>
        {PERIODS.map((entry) => (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityState={{ selected: period === entry.id }}
            onPress={() => setPeriod(entry.id)}
            style={({ pressed }) => pressableStyle([styles.period, period === entry.id && styles.periodOn], { pressed })}
          >
            <Text style={[styles.periodText, period === entry.id && styles.periodTextOn]} numberOfLines={1}>
              {entry.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!shown && !error ? <ActivityIndicator color={colors.muted} style={styles.loading} /> : null}
      {shown ? (
        <>
          <View style={styles.tiles}>
            <Tile label="Tokens" value={chartValue(total)} hint={`${chartValue(shown.totals.inputTokens)} in · ${chartValue(shown.totals.outputTokens)} out`} />
            {shown.totals.estimatedUsd !== undefined ? (
              <Tile
                label="Estimated cost"
                value={dollars(shown.totals.estimatedUsd)}
                hint={shown.totals.unpricedTokens ? `${chartValue(shown.totals.unpricedTokens)} tokens not priced` : "at list prices"}
              />
            ) : null}
            <Tile
              label="From cache"
              value={shown.totals.inputTokens > 0 ? `${Math.round((shown.totals.cacheReadTokens / shown.totals.inputTokens) * 100)}%` : "0%"}
              hint="of what was sent in"
            />
            <Tile label="Turns" value={chartValue(shown.totals.turns)} hint="replies in chats" />
            <Tile label="Jobs" value={chartValue(shown.totals.jobs)} hint="background work" />
          </View>
          {total > 0 ? <UsageChart usage={shown} /> : <Text style={styles.empty}>Nothing used {period === "today" ? "today" : `in the ${label}`}.</Text>}
          {shown.models.length > 0 ? <Text style={styles.section}>By model</Text> : null}
          {shown.models.length > 0 ? (
            <View style={styles.group}>
              {shown.models.map((row, index) => {
                const used = row.inputTokens + row.outputTokens;
                return (
                  <View key={row.key} style={styles.agentRow}>
                    <View style={[styles.modelDot, { backgroundColor: modelColor(index) }]} />
                    <View style={styles.agentBody}>
                      <View style={styles.agentTop}>
                        <Text style={styles.agentName} numberOfLines={1}>
                          {modelName(row.key)}
                        </Text>
                        <Text style={styles.agentTokens}>
                          {chartValue(used)} · {total > 0 ? Math.round((used / total) * 100) : 0}%
                        </Text>
                      </View>
                      <View style={styles.track}>
                        <View style={[styles.fill, { width: `${Math.max(2, Math.round((used / Math.max(1, total)) * 100))}%`, backgroundColor: modelColor(index) }]} />
                      </View>
                      <Text style={styles.hint} numberOfLines={1}>
                        {[
                          row.provider ? providerLabel(row.provider) : "",
                          `${chartValue(row.inputTokens)} in · ${chartValue(row.outputTokens)} out`,
                          row.estimatedUsd !== undefined ? `≈ ${dollars(row.estimatedUsd)}` : "",
                          row.inputTokens > 0 ? `${Math.round((row.cacheReadTokens / row.inputTokens) * 100)}% cached` : "",
                          row.turns > 0 ? `${row.turns} ${row.turns === 1 ? "turn" : "turns"}` : "",
                          row.jobs > 0 ? `${row.jobs} ${row.jobs === 1 ? "job" : "jobs"}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
          {shown.agents.length > 0 ? <Text style={styles.section}>By agent</Text> : null}
          {shown.agents.length > 0 ? (
            <View style={styles.group}>
              {shown.agents.map((row) => {
                const agent = agents.find((entry) => entry.id === row.agentId);
                const used = row.inputTokens + row.outputTokens;
                return (
                  <View key={row.agentId} style={styles.agentRow}>
                    <Avatar
                      id={row.agentId}
                      size={36}
                      shape={agent?.markShape}
                      color={agent?.markColor}
                      material={agent?.markMaterial}
                      style={agent?.markStyle}
                      gender={agent?.markGender}
                      photo={agent?.avatarUrl}
                    />
                    <View style={styles.agentBody}>
                      <View style={styles.agentTop}>
                        <Text style={styles.agentName} numberOfLines={1}>
                          {row.name}
                        </Text>
                        <Text style={styles.agentTokens}>{chartValue(used)}</Text>
                      </View>
                      <View style={styles.track}>
                        <View style={[styles.fill, { width: `${Math.max(2, Math.round((used / most) * 100))}%` }]} />
                      </View>
                      <Text style={styles.hint} numberOfLines={1}>
                        {[`${row.turns} ${row.turns === 1 ? "turn" : "turns"}`, row.jobs > 0 ? `${row.jobs} ${row.jobs === 1 ? "job" : "jobs"}` : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
          <Text style={styles.note}>
            Counted in tokens, as your provider reports them. What that costs depends on the provider and model; cached tokens usually cost much less. Hours and days are in {shown.timezone}.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.hint} numberOfLines={1}>
        {hint}
      </Text>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    scroll: { padding: 14, paddingBottom: 28, gap: 10 },
    periods: { flexDirection: "row", gap: 8 },
    modelDot: { width: 12, height: 12, borderRadius: 4 },
    period: { flex: 1, height: 36, paddingHorizontal: 6, borderRadius: 12, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
    periodOn: { backgroundColor: colors.text },
    periodText: { color: colors.text, fontSize: 14, fontWeight: "600" },
    periodTextOn: { color: colors.bg },
    loading: { marginTop: 40 },
    error: { color: colors.danger, fontSize: 14 },
    empty: { color: colors.muted, fontSize: 15, textAlign: "center", marginVertical: 24 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    tile: { flexGrow: 1, flexBasis: "45%", backgroundColor: colors.card, borderRadius: 16, borderCurve: "continuous", padding: 12, gap: 2 },
    tileValue: { color: colors.text, fontSize: 24, fontWeight: "700", fontVariant: ["tabular-nums"] },
    hint: { color: colors.muted, fontSize: 12 },
    section: { color: colors.muted, fontSize: 13, marginTop: 8, marginLeft: 6 },
    group: { backgroundColor: colors.card, borderRadius: 16, borderCurve: "continuous", paddingVertical: 4 },
    agentRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
    agentBody: { flex: 1, gap: 5 },
    agentTop: { flexDirection: "row", alignItems: "center", gap: 8 },
    agentName: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 },
    agentTokens: { color: colors.text, fontSize: 14, fontVariant: ["tabular-nums"] },
    track: { height: 6, borderRadius: 3, backgroundColor: colors.control, overflow: "hidden" },
    fill: { height: 6, borderRadius: 3, backgroundColor: colors.online },
    note: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 6, marginHorizontal: 6 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
