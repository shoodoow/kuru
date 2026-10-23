import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AgentRunningJob, AgentRunningWork } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { CircleButton } from "../ui/CircleButton";
import { IconChevron, IconClose } from "../ui/icons";
import Feather from "@expo/vector-icons/Feather";
import * as Clipboard from "expo-clipboard";
import { MONO } from "./MarkdownText";

/** How often running work refreshes while on screen. */
const REFRESH_MS = 10_000;

/** Minutes or hours since a moment, in short words. */
function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

const STATE: Record<AgentRunningJob["status"], string> = {
  running: "Running",
  lost: "Stalled",
  done: "Finished",
  failed: "Stopped",
};

/**
 * Running tasks item and modal sheet.
 * Shows only actively running work and replies in progress (never finished jobs).
 */
export function AgentRunningCard({
  onLoad,
  onStop,
}: {
  onLoad: () => Promise<AgentRunningWork>;
  onStop: (workerId: string) => Promise<unknown>;
}) {
  const [work, setWork] = useState<AgentRunningWork | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** Jobs whose full brief is unfolded, keyed like the job cards. */
  const [shownBriefs, setShownBriefs] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);

  const toggleBrief = (key: string) =>
    setShownBriefs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const copyBrief = (key: string, brief: string) => {
    void Clipboard.setStringAsync(brief).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    });
  };

  const load = useCallback(() => {
    void onLoad()
      .then((next) => {
        setWork(next);
        setError(null);
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Running work did not load."));
  }, [onLoad]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stop = (job: AgentRunningJob) => {
    Alert.alert("Stop this task?", job.title, [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop task",
        style: "destructive",
        onPress: () => {
          setStopping(job.workerId);
          void onStop(job.workerId)
            .then(() => load())
            .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "That did not work."))
            .finally(() => setStopping(null));
        },
      },
    ]);
  };

  const runningCount = work?.running.length ?? 0;
  const isBusy = Boolean(work?.replying || runningCount > 0);

  const subtitle = work?.replying
    ? "Writing reply in chat"
    : runningCount > 0
    ? `${runningCount} active task${runningCount === 1 ? "" : "s"}`
    : "Idle · No tasks running";

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Running tasks"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.itemRow, pressed ? styles.rowPressed : null]}
      >
        <View style={[styles.iconWrap, isBusy ? styles.iconBusy : styles.iconIdle]}>
          <Feather name="activity" size={18} color={isBusy ? colors.green : colors.muted} />
        </View>
        <View style={styles.itemBody}>
          <View style={styles.titleRow}>
            <Text style={styles.itemTitle}>Running tasks</Text>
            {isBusy ? <View style={styles.pulseDot} /> : null}
          </View>
          <Text style={styles.itemSub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <IconChevron />
      </Pressable>

      <Sheet open={open} onClose={() => setOpen(false)}>
        <View style={styles.sheetWrap}>
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderTitles}>
              <Text style={styles.sheetTitle}>Running tasks</Text>
              <Text style={styles.sheetSub}>
                {isBusy ? (work?.replying ? "Replying now" : `${runningCount} active`) : "Nothing running"}
              </Text>
            </View>
            <CircleButton label="Close" onPress={() => setOpen(false)}>
              <IconClose />
            </CircleButton>
          </View>

          <ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
            {error ? <Text style={styles.error}>{error}</Text> : null}

            {work?.replying ? (
              <View style={styles.replyingCard}>
                <View style={styles.pulseDot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.replyingTitle}>Writing a reply in chat</Text>
                  <Text style={styles.replyingSub}>The agent is generating an answer right now.</Text>
                </View>
                <ActivityIndicator size="small" color={colors.green} />
              </View>
            ) : null}

            {work?.running.map((job) => {
              const key = job.workerId + job.startedAt;
              const briefShown = shownBriefs.has(key);
              return (
              <View key={key} style={styles.jobCard}>
                <View style={styles.jobHead}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{job.source === "routine" ? "Routine" : "Job"}</Text>
                  </View>
                  <View style={[styles.statusDot, job.status === "running" ? styles.dotGreen : styles.dotWarn]} />
                  <Text style={styles.statusText}>{STATE[job.status]}</Text>
                </View>

                <Text style={styles.jobTitle}>{job.title}</Text>

                <Text style={styles.jobMeta}>
                  Started {since(job.startedAt)} · {job.steps} steps · Last activity {since(job.lastActivityAt)}
                </Text>

                {job.progress ? (
                  <View style={styles.progressBox}>
                    <Text style={styles.progressText}>{job.progress}</Text>
                  </View>
                ) : null}

                {job.brief ? (
                  <View style={styles.briefWrap}>
                    <View style={styles.briefActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={briefShown ? "Hide worker brief" : "Show worker brief"}
                        onPress={() => toggleBrief(key)}
                        style={({ pressed }) => [styles.briefToggle, pressed ? styles.rowPressed : null]}
                      >
                        <Feather name={briefShown ? "chevron-up" : "file-text"} size={14} color={colors.muted} />
                        <Text style={styles.briefToggleText}>
                          {briefShown ? "Hide worker brief" : `Show worker brief · ${job.brief.length.toLocaleString()} chars`}
                        </Text>
                      </Pressable>
                      {briefShown ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Copy worker brief"
                          onPress={() => copyBrief(key, job.brief ?? "")}
                          style={({ pressed }) => [styles.briefToggle, pressed ? styles.rowPressed : null]}
                        >
                          <Feather name={copied === key ? "check" : "copy"} size={14} color={colors.muted} />
                          <Text style={styles.briefToggleText}>{copied === key ? "Copied" : "Copy"}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {briefShown ? (
                      <View style={styles.briefBox}>
                        <Text selectable style={styles.briefText}>
                          {job.brief}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                <Pressable
                  accessibilityRole="button"
                  disabled={stopping !== null}
                  onPress={() => stop(job)}
                  style={({ pressed }) => [styles.stopButton, pressed || stopping ? styles.stopPressed : null]}
                >
                  <Feather name="square" size={14} color={colors.danger} />
                  <Text style={styles.stopText}>{stopping === job.workerId ? "Stopping…" : "Stop task"}</Text>
                </Pressable>
              </View>
              );
            })}

            {!isBusy ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconCircle}>
                  <Feather name="check" size={28} color={colors.green} />
                </View>
                <Text style={styles.emptyTitle}>All quiet</Text>
                <Text style={styles.emptyDesc}>
                  No background jobs or scheduled routines are currently running. Active tasks will appear here automatically.
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Sheet>
    </>
  );
}

function createStyles(theme: ColorPalette) {
  return StyleSheet.create({
    itemRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.bubble,
      borderRadius: 14,
      borderCurve: "continuous",
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    rowPressed: { opacity: 0.7 },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    iconIdle: { backgroundColor: theme.control },
    iconBusy: { backgroundColor: "rgba(52, 199, 89, 0.15)" },
    itemBody: { flex: 1, gap: 2 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    itemTitle: { color: theme.text, fontSize: 16, fontWeight: "500" },
    itemSub: { color: theme.muted, fontSize: 13 },
    pulseDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.green,
    },
    sheetWrap: { flex: 1, backgroundColor: theme.bg },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.line,
    },
    sheetHeaderTitles: { gap: 2 },
    sheetTitle: { color: theme.text, fontSize: 20, fontWeight: "700" },
    sheetSub: { color: theme.muted, fontSize: 13 },
    sheetContent: { padding: 16, gap: 12, paddingBottom: 40 },
    replyingCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.bubble,
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      borderColor: "rgba(52, 199, 89, 0.3)",
    },
    replyingTitle: { color: theme.text, fontSize: 15, fontWeight: "600" },
    replyingSub: { color: theme.muted, fontSize: 12, marginTop: 2 },
    jobCard: {
      backgroundColor: theme.bubble,
      borderRadius: 14,
      borderCurve: "continuous",
      padding: 16,
      gap: 10,
    },
    jobHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    badge: {
      backgroundColor: theme.control,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    badgeText: { color: theme.text, fontSize: 11, fontWeight: "600" },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    dotGreen: { backgroundColor: theme.green },
    dotWarn: { backgroundColor: "#FF9F0A" },
    statusText: { color: theme.muted, fontSize: 12 },
    jobTitle: { color: theme.text, fontSize: 16, fontWeight: "600", lineHeight: 22 },
    jobMeta: { color: theme.muted, fontSize: 12 },
    progressBox: {
      backgroundColor: theme.control,
      borderRadius: 8,
      padding: 10,
    },
    progressText: { color: theme.text, fontSize: 13, lineHeight: 18 },
    briefWrap: { gap: 8 },
    briefActions: { flexDirection: "row", alignItems: "center", gap: 16 },
    briefToggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
    briefToggleText: { color: theme.muted, fontSize: 13, fontWeight: "500" },
    briefBox: {
      backgroundColor: theme.control,
      borderRadius: 8,
      padding: 10,
    },
    briefText: { color: theme.text, fontSize: 12, lineHeight: 17, fontFamily: MONO },
    stopButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      alignSelf: "flex-start",
      paddingHorizontal: 14,
      height: 36,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.danger,
      marginTop: 4,
    },
    stopPressed: { opacity: 0.6 },
    stopText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
    emptyState: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 60,
      paddingHorizontal: 32,
      gap: 12,
    },
    emptyIconCircle: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: "rgba(52, 199, 89, 0.12)",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 6,
    },
    emptyTitle: { color: theme.text, fontSize: 18, fontWeight: "600" },
    emptyDesc: { color: theme.muted, fontSize: 14, textAlign: "center", lineHeight: 20 },
    error: { color: theme.danger, fontSize: 14, marginHorizontal: 4 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
