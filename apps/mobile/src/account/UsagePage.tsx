import { chartValue } from "@nano-agents/shared";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import type { AccountUsage, RosterAgent } from "../api";
import { ChartWidget } from "../chat/ChartWidget";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Avatar } from "../ui/Avatar";
import { pressableStyle } from "../ui/pressableStyles";

const PERIODS = [7, 30, 90] as const;

/**
 * What the account's agents used: tokens, turns and background jobs, by day
 * and by agent.
 * Why: the ring in a chat covers one conversation. This is the whole account,
 * so the person can see how much is being spent and which agent spends it.
 * Money is not shown: prices differ by provider and model and are not known here.
 * Input: the roster (for faces) and a loader for one period. Output: the page.
 */
export function UsagePage({
  agents,
  onLoad,
  scrollStyle,
}: {
  agents: RosterAgent[];
  onLoad: (days: number) => Promise<AccountUsage>;
  scrollStyle: ViewStyle;
}) {
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    onLoad(days)
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
  }, [days]);

  const shown = usage?.days === days ? usage : null;
  const bars = shown ? tokenBars(shown.daily) : { weekly: false, labels: [], values: [] };
  const total = shown ? shown.totals.inputTokens + shown.totals.outputTokens : 0;
  const most = Math.max(1, ...(shown?.agents.map((row) => row.inputTokens + row.outputTokens) ?? []));
  return (
    <ScrollView style={scrollStyle} contentInsetAdjustmentBehavior="automatic" nestedScrollEnabled contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.periods}>
        {PERIODS.map((period) => (
          <Pressable
            key={period}
            accessibilityRole="button"
            accessibilityState={{ selected: days === period }}
            onPress={() => setDays(period)}
            style={({ pressed }) => pressableStyle([styles.period, days === period && styles.periodOn], { pressed })}
          >
            <Text style={[styles.periodText, days === period && styles.periodTextOn]}>{period} days</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!shown && !error ? <ActivityIndicator color={colors.muted} style={styles.loading} /> : null}
      {shown ? (
        <>
          <View style={styles.tiles}>
            <Tile label="Tokens" value={chartValue(total)} hint={`${chartValue(shown.totals.inputTokens)} in · ${chartValue(shown.totals.outputTokens)} out`} />
            <Tile
              label="From cache"
              value={shown.totals.inputTokens > 0 ? `${Math.round((shown.totals.cacheReadTokens / shown.totals.inputTokens) * 100)}%` : "0%"}
              hint="of what was sent in"
            />
            <Tile label="Turns" value={chartValue(shown.totals.turns)} hint="replies in chats" />
            <Tile label="Jobs" value={chartValue(shown.totals.jobs)} hint="background work" />
          </View>
          {total > 0 ? (
            <ChartWidget
              props={{
                type: "bar",
                title: bars.weekly ? "Tokens per week" : "Tokens per day",
                labels: bars.labels,
                values: bars.values,
              }}
            />
          ) : (
            <Text style={styles.empty}>Nothing used in the last {days} days.</Text>
          )}
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
                        {[row.modelId, `${row.turns} ${row.turns === 1 ? "turn" : "turns"}`, row.jobs > 0 ? `${row.jobs} ${row.jobs === 1 ? "job" : "jobs"}` : ""]
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
            Counted in tokens, as your provider reports them. What that costs depends on the provider and model. Days are in {shown.timezone}.
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

/**
 * The bars for the period: one per day, or one per week when there are too
 * many days to read (each week is labelled by the day it starts on).
 */
function tokenBars(daily: AccountUsage["daily"]): { weekly: boolean; labels: string[]; values: number[] } {
  const weekly = daily.length > 31;
  const size = weekly ? 7 : 1;
  const labels: string[] = [];
  const values: number[] = [];
  // Counted back from today, so the newest bar is always a whole week.
  for (let end = daily.length; end > 0; end -= size) {
    const chunk = daily.slice(Math.max(0, end - size), end);
    labels.unshift(dayLabel(chunk[0]!.day));
    values.unshift(chunk.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0));
  }
  return { weekly, labels, values };
}

/** "2026-10-11" as "Oct 11". */
function dayLabel(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(month ?? 1) - 1]} ${date}`;
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    scroll: { padding: 14, paddingBottom: 28, gap: 10 },
    periods: { flexDirection: "row", gap: 8 },
    period: { flex: 1, height: 36, borderRadius: 12, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
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
