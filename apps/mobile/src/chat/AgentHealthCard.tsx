import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentHealth, AgentReflection } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";

const STATUS = {
  healthy: { label: "Healthy", tone: "good" },
  watch: { label: "Worth a look", tone: "warn" },
  "needs attention": { label: "Needs attention", tone: "bad" },
} as const;

/** "2026-10-15T03:12:00Z" as "today 03:12" or "Oct 15". */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === today.toDateString()) return `today ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** One proposed change in words: "New rule: …", "Retired F2", with why it was turned down. */
function editLine(edit: AgentReflection["edits"][number]): string {
  const what =
    edit.op === "rule" ? "New rule" :
    edit.op === "fact" ? "New fact" :
    edit.op === "replace" ? `Reworded ${edit.target}` :
    edit.op === "merge" ? `Merged ${(edit.targets ?? []).join(" + ")}` :
    edit.op === "confirm" ? `Confirmed ${edit.target}` :
    edit.op === "contradict" ? `Weakened ${edit.target}` :
    `Retired ${edit.target}`;
  return `${what}${edit.body ? `: ${edit.body}` : ""}${edit.tentative ? " (not yet confirmed)" : ""}`;
}

const inFlightFixes = new Set<string>();

/**
 * How the agent is doing, and its nightly reflections.
 * Why: an agent's memory now changes on its own every night, so the person
 * must be able to see what changed, judge it, and take it back. The status is
 * measured by the server, not judged by a model. "Fix now" runs a reflection
 * at once; "Undo" takes the last one back, rule by rule.
 * Input: loaders for the health, a reflection now, and an undo.
 */
export function AgentHealthCard({
  agentId,
  onLoad,
  onFix,
  onUndo,
}: {
  agentId?: string;
  onLoad: () => Promise<{ health: AgentHealth; reflections: AgentReflection[]; reflecting?: boolean }>;
  onFix: () => Promise<unknown>;
  onUndo: (reflectionId: string) => Promise<unknown>;
}) {
  const [data, setData] = useState<{ health: AgentHealth; reflections: AgentReflection[]; reflecting?: boolean } | null>(null);
  const [busy, setBusy] = useState<"fix" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // What the last "Reflect now" did, in the server's words ("Nothing new…", "Learned 2 rules…").
  const [notice, setNotice] = useState<string | null>(null);
  // The screen passes a new loader on every render; keeping the latest in a ref
  // stops each render from reloading, which reloaded again in a loop.
  const loader = useRef(onLoad);
  loader.current = onLoad;

  const isFixing = busy === "fix" || (agentId ? inFlightFixes.has(agentId) : false) || Boolean(data?.reflecting);

  const load = useCallback(() => {
    void loader.current()
      .then((res) => {
        setData(res);
        if (!res.reflecting && agentId) {
          inFlightFixes.delete(agentId);
        }
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Health did not load."));
  }, [agentId]);

  useEffect(load, [load]);

  // Poll health while a reflection is in progress so the card auto-refreshes when done
  useEffect(() => {
    if (!isFixing) return;
    const timer = setInterval(() => {
      load();
    }, 4000);
    return () => clearInterval(timer);
  }, [isFixing, load]);

  const act = (kind: "fix" | "undo", action: () => Promise<unknown>) => {
    setBusy(kind);
    if (kind === "fix" && agentId) inFlightFixes.add(agentId);
    setError(null);
    setNotice(null);
    void action()
      .then((result) => {
        const note = (result as { note?: unknown } | null)?.note;
        if (kind === "fix" && typeof note === "string" && note) setNotice(note);
        load();
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "That did not work."))
      .finally(() => {
        setBusy(null);
        if (kind === "fix" && agentId) inFlightFixes.delete(agentId);
      });
  };

  if (!data) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Health</Text>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.muted} />}
      </View>
    );
  }
  const { health, reflections } = data;
  const status = STATUS[health.status];
  const last = reflections.find((row) => row.status === "applied" || row.status === "undone" || row.status === "dry");
  const kept = last?.edits.filter((edit) => !edit.dropped) ?? [];
  const dropped = last?.edits.filter((edit) => edit.dropped) ?? [];
  const m = health.measured;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Health</Text>
        <View style={[styles.dot, styles[status.tone]]} />
        <Text style={styles.status}>{status.label}</Text>
      </View>
      <Text style={styles.measure}>
        {[
          m.stepTokens ? `${Math.round(m.stepTokens / 1000)}k tokens a step` : "",
          `${m.rules} rules${m.tentative ? ` (${m.tentative} unconfirmed)` : ""}`,
          `${m.facts} facts`,
          m.jobs ? `${m.jobs - m.failedJobs}/${m.jobs} jobs done today` : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {health.issues.map((issue) => (
        <Text key={issue} style={styles.issue}>
          • {issue}
        </Text>
      ))}
      {last ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.last}>
          <Text style={styles.lastTitle}>
            {last.status === "undone" ? "Undone" : last.status === "dry" ? "Proposed" : "Last reflection"} {when(last.createdAt)} {open ? "▴" : "▾"}
          </Text>
          <Text style={styles.note}>{last.note}</Text>
          {open ? (
            <View style={styles.edits}>
              {kept.map((edit, index) => (
                <Text key={`k${index}`} style={styles.edit}>
                  {editLine(edit)}
                </Text>
              ))}
              {dropped.map((edit, index) => (
                <Text key={`d${index}`} style={styles.dropped}>
                  Turned down: {editLine(edit)} ({edit.dropped})
                </Text>
              ))}
            </View>
          ) : null}
        </Pressable>
      ) : (
        <Text style={styles.note}>It has not reflected yet. Its first reflection runs after it has worked with you.</Text>
      )}
      {notice ? <Text style={styles.note}>{notice}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Reflects on its recent work now and saves the changes that pass the checks."
          disabled={isFixing || busy !== null}
          onPress={() => act("fix", onFix)}
          style={({ pressed }) => [styles.primary, pressed || isFixing || busy ? styles.pressed : null]}
        >
          <Text style={styles.primaryText}>{isFixing ? "Reflecting…" : health.status === "healthy" ? "Reflect now" : "Fix now"}</Text>
        </Pressable>
        {last?.status === "applied" && kept.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Takes back every change of the last reflection."
            disabled={busy !== null}
            onPress={() => act("undo", () => onUndo(last.id))}
            style={({ pressed }) => [styles.secondary, pressed || busy ? styles.pressed : null]}
          >
            <Text style={styles.secondaryText}>{busy === "undo" ? "Undoing…" : "Undo last"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: { backgroundColor: colors.bubble, borderRadius: 14, borderCurve: "continuous", padding: 14, gap: 8, marginBottom: 12 },
    head: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { color: colors.text, fontSize: 17, fontWeight: "600", flex: 1 },
    dot: { width: 10, height: 10, borderRadius: 5 },
    good: { backgroundColor: colors.green },
    warn: { backgroundColor: "#FF9F0A" },
    bad: { backgroundColor: colors.danger },
    status: { color: colors.text, fontSize: 15 },
    measure: { color: colors.muted, fontSize: 13 },
    issue: { color: colors.text, fontSize: 14, lineHeight: 20 },
    last: { gap: 4, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    lastTitle: { color: colors.muted, fontSize: 13 },
    note: { color: colors.text, fontSize: 14, lineHeight: 20 },
    edits: { gap: 6, marginTop: 4 },
    edit: { color: colors.text, fontSize: 14, lineHeight: 20 },
    dropped: { color: colors.muted, fontSize: 13, lineHeight: 18 },
    error: { color: colors.danger, fontSize: 14 },
    actions: { flexDirection: "row", gap: 10, marginTop: 4 },
    primary: { flex: 1, height: 42, borderRadius: 12, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
    primaryText: { color: colors.bg, fontSize: 15, fontWeight: "600" },
    secondary: { flex: 1, height: 42, borderRadius: 12, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
    secondaryText: { color: colors.text, fontSize: 15 },
    pressed: { opacity: 0.6 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
