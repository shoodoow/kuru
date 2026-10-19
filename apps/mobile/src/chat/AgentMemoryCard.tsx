import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentMemoryFact } from "../api";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";

/** Facts shown before "Show all", so a long memory does not bury the rest of the page. */
const FIRST = 8;

const KIND: Record<string, string> = {
  procedure: "Rule",
  preference: "Preference",
  decision: "Decision",
  person: "Person",
  org: "Organization",
  project: "Project",
  commitment: "Commitment",
  fact: "Fact",
};

/** "2026-10-15T03:12:00Z" as "Oct 15". */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Everything the agent remembers, one fact per row, each removable for good.
 * Why: the person could not see what an agent knew, so a wrong or stale fact
 * (an old style, a rejected idea) kept steering its work with no way to find
 * it. Its own facts come first; shared ones are marked, since removing one
 * removes it for every agent.
 * Input: loaders to list facts and to remove one.
 */
export function AgentMemoryCard({
  onLoad,
  onForget,
}: {
  onLoad: () => Promise<AgentMemoryFact[]>;
  onForget: (memoryId: string) => Promise<unknown>;
}) {
  const [facts, setFacts] = useState<AgentMemoryFact[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void onLoad()
      .then(setFacts)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Memory did not load."));
    // The loader is recreated with the screen; loading once per mount is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  const forget = (fact: AgentMemoryFact) => {
    const shared = fact.scope === "shared";
    Alert.alert(
      "Remove this memory?",
      shared ? "This is shared, so every agent forgets it. It cannot be undone." : "The agent forgets it for good. It cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setBusyId(fact.id);
            setError(null);
            void onForget(fact.id)
              .then(() => {
                setFacts((rows) => rows?.filter((row) => row.id !== fact.id) ?? rows);
                setOpenId(null);
              })
              .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "That did not work."))
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  };

  if (!facts) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Memory</Text>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={styles.muted.color} />}
      </View>
    );
  }
  const own = facts.filter((fact) => fact.scope === "agent").length;
  const shown = all ? facts : facts.slice(0, FIRST);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Memory</Text>
      <Text style={styles.muted}>
        {own} of its own · {facts.length - own} shared with every agent. Tap one to read it or remove it.
      </Text>
      {facts.length === 0 ? <Text style={styles.body}>It does not remember anything yet.</Text> : null}
      {shown.map((fact) => {
        const open = openId === fact.id;
        return (
          <Pressable
            key={fact.id}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpenId(open ? null : fact.id)}
            style={styles.row}
          >
            <Text style={styles.meta}>
              {KIND[fact.kind] ?? "Fact"}
              {fact.subject ? ` · ${fact.subject}` : ""}
              {fact.scope === "shared" ? " · Shared" : ""}
              {fact.tentative ? " · Not yet confirmed" : ""} · {day(fact.createdAt)}
            </Text>
            <Text style={styles.body} numberOfLines={open ? undefined : 2}>
              {fact.body}
            </Text>
            {open ? (
              <Pressable
                accessibilityRole="button"
                accessibilityHint={fact.scope === "shared" ? "Removes it for every agent." : "The agent forgets it for good."}
                disabled={busyId !== null}
                onPress={() => forget(fact)}
                style={({ pressed }) => [styles.remove, pressed || busyId ? styles.pressed : null]}
              >
                <Text style={styles.removeText}>{busyId === fact.id ? "Removing…" : "Remove"}</Text>
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
      {facts.length > FIRST ? (
        <Pressable accessibilityRole="button" onPress={() => setAll((value) => !value)} style={styles.more}>
          <Text style={styles.moreText}>{all ? "Show fewer" : `Show all ${facts.length}`}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: { backgroundColor: colors.bubble, borderRadius: 14, borderCurve: "continuous", padding: 14, gap: 8, marginBottom: 12 },
    title: { color: colors.text, fontSize: 17, fontWeight: "600" },
    muted: { color: colors.muted, fontSize: 13 },
    row: { gap: 3, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    meta: { color: colors.muted, fontSize: 12 },
    body: { color: colors.text, fontSize: 14, lineHeight: 20 },
    remove: { alignSelf: "flex-start", marginTop: 6, paddingHorizontal: 14, height: 34, borderRadius: 10, borderWidth: 1, borderColor: colors.danger, alignItems: "center", justifyContent: "center" },
    removeText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
    more: { paddingTop: 6 },
    moreText: { color: colors.text, fontSize: 14, fontWeight: "600" },
    error: { color: colors.danger, fontSize: 14 },
    pressed: { opacity: 0.6 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
