import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentRunningJob, AgentRunningWork } from "../api";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";

/** How often the card refreshes while it is on screen. */
const REFRESH_MS = 15_000;

/** Minutes or hours since a moment, in short words. */
function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

const STATE: Record<AgentRunningJob["status"], string> = {
  running: "Running",
  lost: "Stalled (the server restarted)",
  done: "Finished",
  failed: "Stopped or failed",
};

/**
 * What the agent is doing right now: its reply in progress, its background
 * jobs and routine runs, and what ended in the last day. Each running job can be stopped.
 * Why: the app showed the agent as busy with no way to see on what, and the
 * agent's own answer ("nothing is running") was sometimes wrong. This reads
 * the server's rows, not the agent's word.
 * Input: loaders to read the work and to stop one job.
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

  const load = useCallback(() => {
    void onLoad()
      .then((next) => {
        setWork(next);
        setError(null);
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Running work did not load."));
    // The loader is recreated with the screen; the interval below keeps it fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stop = (job: AgentRunningJob) => {
    Alert.alert("Stop this job?", job.title, [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop",
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

  if (!work) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Running now</Text>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={styles.muted.color} />}
      </View>
    );
  }
  const idle = !work.replying && work.running.length === 0;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Running now</Text>
        <View style={[styles.dot, idle ? styles.idle : styles.busy]} />
      </View>
      {work.replying ? <Text style={styles.body}>Writing a reply in its chat.</Text> : null}
      {idle ? <Text style={styles.muted}>Nothing is running.</Text> : null}
      {work.running.map((job) => (
        <View key={job.workerId + job.startedAt} style={styles.row}>
          <Text style={styles.jobTitle}>{job.title}</Text>
          <Text style={styles.meta}>
            {job.source === "routine" ? "Routine" : "Job"} · {STATE[job.status]} · started {since(job.startedAt)} · {job.steps} steps · last activity {since(job.lastActivityAt)}
          </Text>
          {job.progress ? <Text style={styles.body}>{job.progress}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={stopping !== null}
            onPress={() => stop(job)}
            style={({ pressed }) => [styles.stop, pressed || stopping ? styles.pressed : null]}
          >
            <Text style={styles.stopText}>{stopping === job.workerId ? "Stopping…" : "Stop"}</Text>
          </Pressable>
        </View>
      ))}
      {work.recent.length > 0 ? <Text style={styles.section}>Ended in the last day</Text> : null}
      {work.recent.map((job) => (
        <View key={job.workerId + job.startedAt} style={styles.row}>
          <Text style={styles.jobTitle} numberOfLines={1}>
            {job.title}
          </Text>
          <Text style={styles.meta}>
            {job.source === "routine" ? "Routine" : "Job"} · {STATE[job.status]} · {since(job.lastActivityAt)}
          </Text>
          {job.result ? (
            <Text style={styles.body} numberOfLines={3}>
              {job.result}
            </Text>
          ) : null}
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: { backgroundColor: colors.bubble, borderRadius: 14, borderCurve: "continuous", padding: 14, gap: 8, marginBottom: 12 },
    head: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { color: colors.text, fontSize: 17, fontWeight: "600", flex: 1 },
    dot: { width: 10, height: 10, borderRadius: 5 },
    busy: { backgroundColor: colors.green },
    idle: { backgroundColor: colors.line },
    section: { color: colors.muted, fontSize: 13, marginTop: 4 },
    row: { gap: 3, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    jobTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
    meta: { color: colors.muted, fontSize: 12 },
    muted: { color: colors.muted, fontSize: 14 },
    body: { color: colors.text, fontSize: 14, lineHeight: 20 },
    stop: { alignSelf: "flex-start", marginTop: 6, paddingHorizontal: 14, height: 34, borderRadius: 10, borderWidth: 1, borderColor: colors.danger, alignItems: "center", justifyContent: "center" },
    stopText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
    error: { color: colors.danger, fontSize: 14 },
    pressed: { opacity: 0.6 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
