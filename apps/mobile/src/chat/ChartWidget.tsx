import { chartData, chartScale, chartValue, type ChartData } from "@kuru/shared";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect } from "react-native-svg";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";

/** One colour per series or slice, in order; they repeat past six. */
const PALETTE = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#64D2FF"];
const colorAt = (index: number): string => PALETTE[index % PALETTE.length]!;

const PLOT_HEIGHT = 150;
const AXIS_WIDTH = 38;

/**
 * Draws the chart an agent sent: bars, a line, or a pie.
 * Why: the old chart was a column of unlabelled bars. A chart is sent when the
 * shape of the numbers is the point, so it needs labels, a scale, a legend,
 * and the right form for the data.
 * Input: the widget's props (read by `chartData`, shared with the core).
 * Output: the card, or a plain line when there is nothing to draw.
 */
export function ChartWidget({ props }: { props: Record<string, unknown> }) {
  const chart = chartData(props);
  const [width, setWidth] = useState(0);
  if (!chart) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{String(props.title ?? "Chart")}</Text>
        <Text style={styles.muted}>No data to show.</Text>
      </View>
    );
  }
  return (
    <View style={styles.card} accessible accessibilityLabel={describe(chart)}>
      {chart.title ? <Text style={styles.title}>{chart.title}</Text> : null}
      <View onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}>
        {width > 0 ? chart.type === "pie" ? <Pie chart={chart} width={width} /> : <Plot chart={chart} width={width} /> : null}
      </View>
      {chart.type !== "pie" && chart.series.length > 1 ? (
        <View style={styles.legend}>
          {chart.series.map((entry, index) => (
            <View key={index} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: colorAt(index) }]} />
              <Text style={styles.muted} numberOfLines={1}>
                {entry.name || `Series ${index + 1}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** What a screen reader says in place of the picture. */
function describe(chart: ChartData): string {
  const first = chart.series[0]!;
  const points = chart.labels.slice(0, 12).map((label, index) => `${label} ${chartValue(first.values[index] ?? 0, chart.unit)}`);
  return `${chart.title || "Chart"}, ${chart.type} chart. ${points.join(", ")}`;
}

/** Bars or lines on a shared scale, with the value axis on the left and labels below. */
function Plot({ chart, width }: { chart: ChartData; width: number }) {
  const all = chart.series.flatMap((entry) => entry.values);
  // Bars are measured from zero; a line may start higher so a trend is not flattened.
  const { min, max, ticks } = chartScale(Math.min(...all), Math.max(...all), chart.type === "bar");
  const plotWidth = width - AXIS_WIDTH;
  const count = chart.labels.length;
  const y = (value: number): number => 6 + (PLOT_HEIGHT - 12) * (1 - (value - min) / (max - min || 1));
  const slot = plotWidth / count;
  const center = (index: number): number => AXIS_WIDTH + slot * (index + 0.5);
  // Labels are thinned out when there is not room for every one.
  const every = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / 44))));
  return (
    <View>
      <Svg width={width} height={PLOT_HEIGHT}>
        {ticks.map((tick) => (
          <Line key={tick} x1={AXIS_WIDTH} x2={width} y1={y(tick)} y2={y(tick)} stroke={colors.line} strokeWidth={tick === 0 ? 1 : StyleSheet.hairlineWidth} />
        ))}
        {chart.type === "bar"
          ? chart.series.map((entry, seriesIndex) => {
              const group = Math.min(slot * 0.72, 44 * chart.series.length);
              const bar = group / chart.series.length;
              return entry.values.map((value, index) => {
                const top = Math.min(y(value), y(0));
                return (
                  <Rect
                    key={`${seriesIndex}-${index}`}
                    x={center(index) - group / 2 + bar * seriesIndex + 1}
                    y={top}
                    width={Math.max(1, bar - 2)}
                    height={Math.max(1, Math.abs(y(value) - y(0)))}
                    rx={Math.min(4, bar / 3)}
                    fill={colorAt(seriesIndex)}
                  />
                );
              });
            })
          : chart.series.map((entry, seriesIndex) => {
              const path = entry.values.map((value, index) => `${index === 0 ? "M" : "L"}${center(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
              return (
                <G key={seriesIndex}>
                  {chart.series.length === 1 && count > 1 ? (
                    <Path d={`${path} L${center(count - 1).toFixed(1)},${y(min).toFixed(1)} L${center(0).toFixed(1)},${y(min).toFixed(1)} Z`} fill={colorAt(0)} opacity={0.14} />
                  ) : null}
                  <Path d={path} stroke={colorAt(seriesIndex)} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" fill="none" />
                  {count <= 24 ? entry.values.map((value, index) => <Circle key={index} cx={center(index)} cy={y(value)} r={3} fill={colorAt(seriesIndex)} />) : null}
                </G>
              );
            })}
      </Svg>
      {ticks.map((tick) => (
        <Text key={tick} style={[styles.tick, { top: y(tick) - 7 }]} numberOfLines={1}>
          {chartValue(tick, chart.unit)}
        </Text>
      ))}
      <View style={[styles.labels, { marginLeft: AXIS_WIDTH }]}>
        {chart.labels.map((label, index) => (
          <Text key={index} style={[styles.label, { width: slot }]} numberOfLines={1}>
            {index % every === 0 ? label : ""}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** A ring of slices beside a list that names each one with its value and share. */
function Pie({ chart, width }: { chart: ChartData; width: number }) {
  const values = chart.series[0]!.values.map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0);
  const size = Math.min(120, Math.floor(width * 0.42));
  const radius = size / 2;
  const inner = radius * 0.56;
  const point = (angle: number, distance: number): string =>
    `${(radius + distance * Math.sin(angle)).toFixed(2)},${(radius - distance * Math.cos(angle)).toFixed(2)}`;
  let turned = 0;
  const slices = values.map((value, index) => {
    const start = turned;
    // A whole circle cannot be drawn as one arc, so a lone slice stops just short.
    const sweep = total > 0 ? Math.min((value / total) * Math.PI * 2, Math.PI * 2 - 0.0001) : 0;
    turned += total > 0 ? (value / total) * Math.PI * 2 : 0;
    const end = start + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    return {
      index,
      value,
      d: `M${point(start, radius)} A${radius},${radius} 0 ${large} 1 ${point(end, radius)} L${point(end, inner)} A${inner},${inner} 0 ${large} 0 ${point(start, inner)} Z`,
    };
  });
  return (
    <View style={styles.pieRow}>
      <Svg width={size} height={size}>
        {total > 0 ? (
          slices.filter((slice) => slice.value > 0).map((slice) => <Path key={slice.index} d={slice.d} fill={colorAt(slice.index)} />)
        ) : (
          <Circle cx={radius} cy={radius} r={(radius + inner) / 2} stroke={colors.line} strokeWidth={radius - inner} fill="none" />
        )}
      </Svg>
      <View style={styles.pieList}>
        {chart.labels.map((label, index) => (
          <View key={index} style={styles.pieItem}>
            <View style={[styles.swatch, { backgroundColor: colorAt(index) }]} />
            <Text style={styles.pieLabel} numberOfLines={1}>
              {label}
            </Text>
            <Text style={styles.muted}>
              {chartValue(values[index] ?? 0, chart.unit)}
              {total > 0 ? ` · ${Math.round(((values[index] ?? 0) / total) * 100)}%` : ""}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: { backgroundColor: colors.bubble, borderRadius: 20, padding: 12, gap: 10 },
    title: { color: colors.text, fontWeight: "700", fontSize: 15 },
    muted: { color: colors.muted, fontSize: 12, fontVariant: ["tabular-nums"] },
    tick: { position: "absolute", left: 0, width: AXIS_WIDTH - 6, textAlign: "right", color: colors.muted, fontSize: 10, fontVariant: ["tabular-nums"] },
    labels: { flexDirection: "row", marginTop: 4 },
    label: { color: colors.muted, fontSize: 10, textAlign: "center" },
    legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
    swatch: { width: 10, height: 10, borderRadius: 3 },
    pieRow: { flexDirection: "row", alignItems: "center", gap: 14 },
    pieList: { flex: 1, gap: 6 },
    pieItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    pieLabel: { color: colors.text, fontSize: 13, flex: 1 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
