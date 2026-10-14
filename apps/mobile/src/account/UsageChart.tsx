import { chartScale, chartValue } from "@kuru/shared";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import Svg, { Line, Rect } from "react-native-svg";
import type { AccountUsage } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";

/** One colour per model, heaviest first; they repeat past six. */
const PALETTE = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#64D2FF"];
export const modelColor = (index: number): string => PALETTE[index % PALETTE.length]!;

const PLOT_HEIGHT = 170;
const AXIS_WIDTH = 40;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The short label under a bar: "14" for an hour, "Tue" in a week, "14" for a day of the month. */
function barLabel(key: string, usage: AccountUsage): string {
  if (usage.bucket === "hour") return key;
  const date = new Date(`${key}T00:00:00Z`);
  return usage.period === "week" ? WEEKDAYS[date.getUTCDay()]! : String(date.getUTCDate());
}

/** The full name of a bar for the detail line: "14:00–15:00" or "Tue, Oct 14". */
export function bucketTitle(key: string, bucket: AccountUsage["bucket"]): string {
  if (bucket === "hour") return `${key}:00–${String((Number(key) + 1) % 24).padStart(2, "0")}:00`;
  const date = new Date(`${key}T00:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** A model key "provider/model" as people read it: the model id. */
export function modelName(key: string): string {
  return key === "unknown" ? "Unknown model" : key.slice(key.indexOf("/") + 1);
}

/**
 * Tokens per hour or day, stacked by model, that the person can touch.
 * Why: a still picture showed the shape but not the numbers. Touching or
 * dragging across the bars picks one and shows exactly what it used, per
 * model, without leaving the page. The newest bar is picked at first.
 * Input: the loaded usage. Output: the detail line and the chart.
 */
export function UsageChart({ usage }: { usage: AccountUsage }) {
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState(usage.series.length - 1);
  // A new period starts on its newest bar.
  useEffect(() => setPicked(usage.series.length - 1), [usage.period, usage.series.length]);

  const order = usage.models.map((model) => model.key);
  const count = usage.series.length;
  const totals = usage.series.map((row) => row.inputTokens + row.outputTokens);
  const { max, ticks } = chartScale(0, Math.max(1, ...totals));
  const plotWidth = Math.max(1, width - AXIS_WIDTH);
  const slot = plotWidth / Math.max(1, count);
  const bar = Math.max(2, Math.min(slot * 0.7, 28));
  const y = (value: number): number => 6 + (PLOT_HEIGHT - 12) * (1 - value / (max || 1));
  const every = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / 30))));

  const pick = (event: GestureResponderEvent): void => {
    const index = Math.floor((event.nativeEvent.locationX - AXIS_WIDTH) / slot);
    setPicked(Math.min(count - 1, Math.max(0, index)));
  };
  const chosen = usage.series[Math.min(picked, count - 1)];
  const chosenTotal = chosen ? chosen.inputTokens + chosen.outputTokens : 0;
  return (
    <View style={styles.card}>
      {chosen ? (
        <View style={styles.detail}>
          <View style={styles.detailTop}>
            <Text style={styles.detailWhen}>{bucketTitle(chosen.key, usage.bucket)}</Text>
            <Text style={styles.detailTotal}>{chartValue(chosenTotal)} tokens</Text>
          </View>
          {chosenTotal > 0 ? (
            order
              .filter((key) => (chosen.models[key] ?? 0) > 0)
              .map((key) => (
                <View key={key} style={styles.detailRow}>
                  <View style={[styles.swatch, { backgroundColor: modelColor(order.indexOf(key)) }]} />
                  <Text style={styles.detailModel} numberOfLines={1}>
                    {modelName(key)}
                  </Text>
                  <Text style={styles.detailValue}>{chartValue(chosen.models[key] ?? 0)}</Text>
                </View>
              ))
          ) : (
            <Text style={styles.muted}>Nothing used.</Text>
          )}
          {chosenTotal > 0 ? (
            <Text style={styles.muted}>
              {[
                `${chartValue(chosen.inputTokens)} in · ${chartValue(chosen.outputTokens)} out`,
                chosen.turns > 0 ? `${chosen.turns} ${chosen.turns === 1 ? "turn" : "turns"}` : "",
                chosen.jobs > 0 ? `${chosen.jobs} ${chosen.jobs === 1 ? "job" : "jobs"}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View
        onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        // A vertical swipe still scrolls the page.
        onResponderTerminationRequest={() => true}
        onResponderGrant={pick}
        onResponderMove={pick}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={chosen ? `${bucketTitle(chosen.key, usage.bucket)}, ${chartValue(chosenTotal)} tokens` : "Usage chart"}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) =>
          setPicked((index) => Math.min(count - 1, Math.max(0, index + (event.nativeEvent.actionName === "increment" ? 1 : -1))))
        }
      >
        {width > 0 ? (
          <View pointerEvents="none">
            <Svg width={width} height={PLOT_HEIGHT}>
              {ticks.map((tick) => (
                <Line key={tick} x1={AXIS_WIDTH} x2={width} y1={y(tick)} y2={y(tick)} stroke={colors.line} strokeWidth={tick === 0 ? 1 : StyleSheet.hairlineWidth} />
              ))}
              {usage.series.map((row, index) => {
                let base = 0;
                const x = AXIS_WIDTH + slot * index + (slot - bar) / 2;
                const faded = index !== picked;
                return order.map((key, modelIndex) => {
                  const value = row.models[key] ?? 0;
                  if (value <= 0) return null;
                  const top = y(base + value);
                  const height = Math.max(1, y(base) - top);
                  base += value;
                  return (
                    <Rect
                      key={`${index}-${key}`}
                      x={x}
                      y={top}
                      width={bar}
                      height={height}
                      rx={Math.min(3, bar / 4)}
                      fill={modelColor(modelIndex)}
                      opacity={faded ? 0.45 : 1}
                    />
                  );
                });
              })}
            </Svg>
            {ticks.map((tick) => (
              <Text key={tick} style={[styles.tick, { top: y(tick) - 7 }]} numberOfLines={1}>
                {chartValue(tick)}
              </Text>
            ))}
            <View style={[styles.labels, { marginLeft: AXIS_WIDTH }]}>
              {usage.series.map((row, index) => (
                <Text key={row.key} style={[styles.label, { width: slot }, index === picked && styles.labelOn]} numberOfLines={1}>
                  {index % every === 0 || index === picked ? barLabel(row.key, usage) : ""}
                </Text>
              ))}
            </View>
          </View>
        ) : (
          <View style={{ height: PLOT_HEIGHT }} />
        )}
      </View>
      <Text style={styles.muted}>Touch or slide across the bars to see each {usage.bucket === "hour" ? "hour" : "day"}.</Text>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: { backgroundColor: colors.card, borderRadius: 16, borderCurve: "continuous", padding: 12, gap: 10 },
    detail: { gap: 4, minHeight: 64 },
    detailTop: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    detailWhen: { color: colors.muted, fontSize: 13, flex: 1 },
    detailTotal: { color: colors.text, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
    detailRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    detailModel: { color: colors.text, fontSize: 14, flex: 1 },
    detailValue: { color: colors.text, fontSize: 14, fontVariant: ["tabular-nums"] },
    swatch: { width: 10, height: 10, borderRadius: 3 },
    muted: { color: colors.muted, fontSize: 12 },
    tick: { position: "absolute", left: 0, width: AXIS_WIDTH - 6, textAlign: "right", color: colors.muted, fontSize: 10, fontVariant: ["tabular-nums"] },
    labels: { flexDirection: "row", marginTop: 4 },
    label: { color: colors.muted, fontSize: 10, textAlign: "center" },
    labelOn: { color: colors.text, fontWeight: "700" },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
