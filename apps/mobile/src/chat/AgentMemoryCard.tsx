import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import type { AgentMemoryFact } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { CircleButton } from "../ui/CircleButton";
import { IconChevron, IconClose, IconCopy, IconSearch } from "../ui/icons";
import Feather from "@expo/vector-icons/Feather";

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

type FilterTab = "all" | "rules" | "facts" | "shared";

/**
 * Individual memory row with swipe-to-right to delete gesture
 * and expand/collapse on tap.
 */
function SwipeableMemoryRow({
  fact,
  isExpanded,
  onToggleExpand,
  onOpenReader,
  onDelete,
  onSwipeActive,
}: {
  fact: AgentMemoryFact;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOpenReader: () => void;
  onDelete: () => void;
  onSwipeActive?: (active: boolean) => void;
}) {
  const pan = useRef(new Animated.Value(0)).current;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => {
        // Strict horizontal gate: only claim when moving right, horizontal strictly dominates vertical (2.5x), and vertical drift is tiny (<10)
        return gesture.dx > 16 && Math.abs(gesture.dy) < 10 && gesture.dx > Math.abs(gesture.dy) * 2.5;
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        onSwipeActive?.(true);
      },
      onPanResponderMove: (_, gesture) => {
        if (gesture.dx > 0) {
          pan.setValue(Math.min(gesture.dx, 160));
        }
      },
      onPanResponderRelease: (_, gesture) => {
        onSwipeActive?.(false);
        if (gesture.dx > 80) {
          if (process.env.EXPO_OS === "ios") {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }
          Animated.timing(pan, {
            toValue: 120,
            duration: 150,
            useNativeDriver: true,
          }).start(() => {
            onDelete();
            Animated.spring(pan, {
              toValue: 0,
              friction: 8,
              tension: 50,
              useNativeDriver: true,
            }).start();
          });
        } else {
          Animated.spring(pan, {
            toValue: 0,
            friction: 8,
            tension: 50,
            useNativeDriver: true,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        onSwipeActive?.(false);
        Animated.spring(pan, {
          toValue: 0,
          friction: 8,
          tension: 50,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  const kindLabel = KIND[fact.kind] ?? (fact.kind === "procedure" ? "Rule" : "Fact");
  const isRule = fact.kind === "procedure";
  const isLong = fact.body.length > 150;

  return (
    <View style={styles.swipeContainer}>
      {/* Background delete action revealed on right swipe */}
      <View style={styles.deleteBackdrop}>
        <Feather name="trash-2" size={20} color="#FFFFFF" />
        <Text style={styles.deleteText}>Remove</Text>
      </View>

      {/* Front card */}
      <Animated.View
        style={[styles.rowFront, { transform: [{ translateX: pan }] }]}
        {...responder.panHandlers}
      >
        <Pressable
          accessibilityRole="button"
          onPress={onToggleExpand}
          style={({ pressed }) => [styles.rowPressable, pressed ? styles.rowPressed : null]}
        >
          <View style={styles.metaRow}>
            <View style={[styles.kindTag, isRule ? styles.ruleTag : styles.factTag]}>
              <Text style={[styles.kindTagText, isRule ? styles.ruleTagText : styles.factTagText]}>
                {kindLabel}
              </Text>
            </View>
            {fact.scope === "shared" ? (
              <View style={styles.sharedTag}>
                <Text style={styles.sharedTagText}>Shared</Text>
              </View>
            ) : null}
            {fact.tentative ? (
              <View style={styles.tentativeTag}>
                <Text style={styles.tentativeTagText}>Tentative</Text>
              </View>
            ) : null}
            <Text style={styles.dateText}>{day(fact.createdAt)}</Text>
          </View>

          <Text style={styles.factBody} numberOfLines={isExpanded ? undefined : 3}>
            {fact.body}
          </Text>

          <View style={styles.rowFooter}>
            <Text style={styles.expandHint}>
              {isExpanded ? "Tap to collapse" : "Tap to expand · Swipe right to remove"}
            </Text>
            {isLong ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Read full memory"
                onPress={(e) => {
                  e.stopPropagation?.();
                  onOpenReader();
                }}
                style={styles.readerButton}
              >
                <Feather name="maximize-2" size={13} color={colors.link} />
                <Text style={styles.readerButtonText}>Full text</Text>
              </Pressable>
            ) : null}
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * Clean reader popup modal for viewing long memories.
 */
function MemoryReaderModal({
  fact,
  onClose,
}: {
  fact: AgentMemoryFact | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!fact) return null;

  const copy = async () => {
    await Clipboard.setStringAsync(fact.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const kindLabel = KIND[fact.kind] ?? (fact.kind === "procedure" ? "Rule" : "Fact");

  return (
    <Modal visible={Boolean(fact)} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modalHead}>
            <View style={styles.modalMeta}>
              <View style={[styles.kindTag, fact.kind === "procedure" ? styles.ruleTag : styles.factTag]}>
                <Text style={[styles.kindTagText, fact.kind === "procedure" ? styles.ruleTagText : styles.factTagText]}>
                  {kindLabel}
                </Text>
              </View>
              {fact.scope === "shared" ? (
                <View style={styles.sharedTag}>
                  <Text style={styles.sharedTagText}>Shared</Text>
                </View>
              ) : null}
              <Text style={styles.dateText}>{day(fact.createdAt)}</Text>
            </View>
            <CircleButton label="Close" onPress={onClose}>
              <IconClose />
            </CircleButton>
          </View>

          <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={true}>
            <Text style={styles.modalBody}>{fact.body}</Text>
          </ScrollView>

          <View style={styles.modalFooter}>
            <Pressable accessibilityRole="button" onPress={copy} style={styles.copyButton}>
              <IconCopy />
              <Text style={styles.copyText}>{copied ? "Copied!" : "Copy text"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.doneButton}>
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Memory item and full management sheet.
 * Expands on tap, opens full reader popup, and deletes via swipe-to-right.
 */
export function AgentMemoryCard({
  onLoad,
  onForget,
}: {
  onLoad: () => Promise<AgentMemoryFact[]>;
  onForget: (memoryId: string) => Promise<unknown>;
}) {
  const [facts, setFacts] = useState<AgentMemoryFact[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [readerFact, setReaderFact] = useState<AgentMemoryFact | null>(null);
  const [isSwipingRow, setIsSwipingRow] = useState(false);

  const load = useCallback(() => {
    void onLoad()
      .then(setFacts)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Memory did not load."));
  }, [onLoad]);

  useEffect(load, [load]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const forget = (fact: AgentMemoryFact) => {
    const shared = fact.scope === "shared";
    Alert.alert(
      "Remove this memory?",
      shared
        ? "This memory is shared across all agents. Removing it deletes it for every agent permanently."
        : "The agent will permanently forget this memory. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void onForget(fact.id)
              .then(() => {
                setFacts((rows) => rows?.filter((row) => row.id !== fact.id) ?? rows);
              })
              .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not remove."));
          },
        },
      ]
    );
  };

  const totalCount = facts?.length ?? 0;
  const rulesCount = useMemo(() => facts?.filter((f) => f.kind === "procedure").length ?? 0, [facts]);
  const factsCount = useMemo(() => facts?.filter((f) => f.kind !== "procedure").length ?? 0, [facts]);
  const sharedCount = useMemo(() => facts?.filter((f) => f.scope === "shared").length ?? 0, [facts]);

  const filteredFacts = useMemo(() => {
    if (!facts) return [];
    return facts.filter((f) => {
      if (activeTab === "rules" && f.kind !== "procedure") return false;
      if (activeTab === "facts" && f.kind === "procedure") return false;
      if (activeTab === "shared" && f.scope !== "shared") return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return f.body.toLowerCase().includes(q) || (f.subject?.toLowerCase().includes(q) ?? false);
      }
      return true;
    });
  }, [facts, activeTab, search]);

  const subtitle = facts === null
    ? "Loading memories…"
    : `${totalCount} item${totalCount === 1 ? "" : "s"} (${rulesCount} rules, ${factsCount} facts)`;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Memories"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.itemRow, pressed ? styles.rowPressed : null]}
      >
        <View style={styles.iconWrap}>
          <Feather name="bookmark" size={18} color={colors.label} />
        </View>
        <View style={styles.itemBody}>
          <Text style={styles.itemTitle}>Memory</Text>
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
              <Text style={styles.sheetTitle}>Memory</Text>
              <Text style={styles.sheetSub}>
                {totalCount} memories · Swipe right to remove
              </Text>
            </View>
            <CircleButton label="Close" onPress={() => setOpen(false)}>
              <IconClose />
            </CircleButton>
          </View>

          {/* Search bar */}
          <View style={styles.searchBar}>
            <IconSearch />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search memories…"
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
              clearButtonMode="while-editing"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {search.length > 0 && process.env.EXPO_OS !== "ios" ? (
              <Pressable onPress={() => setSearch("")} hitSlop={8}>
                <Feather name="x" size={16} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>

          {/* Filter segment tabs */}
          <View style={styles.filterTabs}>
            {(
              [
                { id: "all", label: `All (${totalCount})` },
                { id: "rules", label: `Rules (${rulesCount})` },
                { id: "facts", label: `Facts (${factsCount})` },
                { id: "shared", label: `Shared (${sharedCount})` },
              ] as const
            ).map((tab) => (
              <Pressable
                key={tab.id}
                onPress={() => setActiveTab(tab.id)}
                style={[styles.filterChip, activeTab === tab.id ? styles.filterChipActive : null]}
              >
                <Text style={[styles.filterChipText, activeTab === tab.id ? styles.filterChipTextActive : null]}>
                  {tab.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView
            scrollEnabled={!isSwipingRow}
            contentContainerStyle={styles.sheetContent}
            showsVerticalScrollIndicator={false}
          >
            {error ? <Text style={styles.error}>{error}</Text> : null}

            {filteredFacts.map((fact) => (
              <SwipeableMemoryRow
                key={fact.id}
                fact={fact}
                isExpanded={expandedIds.has(fact.id)}
                onToggleExpand={() => toggleExpand(fact.id)}
                onOpenReader={() => setReaderFact(fact)}
                onDelete={() => forget(fact)}
                onSwipeActive={setIsSwipingRow}
              />
            ))}

            {filteredFacts.length === 0 ? (
              <View style={styles.emptyState}>
                <Feather name="bookmark" size={32} color={colors.muted} />
                <Text style={styles.emptyTitle}>
                  {search ? "No matching memories" : "No memories saved yet"}
                </Text>
                <Text style={styles.emptyDesc}>
                  {search
                    ? `No memories matched "${search}". Try a different search term.`
                    : "The agent gathers rules and facts as it interacts and reflects on its work."}
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Sheet>

      {/* Reader popup for long memories */}
      <MemoryReaderModal fact={readerFact} onClose={() => setReaderFact(null)} />
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
      backgroundColor: theme.control,
      alignItems: "center",
      justifyContent: "center",
    },
    itemBody: { flex: 1, gap: 2 },
    itemTitle: { color: theme.text, fontSize: 16, fontWeight: "500" },
    itemSub: { color: theme.muted, fontSize: 13 },
    sheetWrap: { flex: 1, backgroundColor: theme.bg },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.line,
    },
    sheetHeaderTitles: { gap: 2 },
    sheetTitle: { color: theme.text, fontSize: 20, fontWeight: "700" },
    sheetSub: { color: theme.muted, fontSize: 13 },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.bubble,
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 8,
      paddingHorizontal: 14,
      height: 42,
      borderRadius: 12,
      borderCurve: "continuous",
    },
    searchInput: { flex: 1, color: theme.text, fontSize: 15 },
    filterTabs: {
      flexDirection: "row",
      paddingHorizontal: 16,
      paddingBottom: 10,
      gap: 8,
    },
    filterChip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 10,
      backgroundColor: theme.bubble,
    },
    filterChipActive: { backgroundColor: theme.control },
    filterChipText: { color: theme.muted, fontSize: 13, fontWeight: "500" },
    filterChipTextActive: { color: theme.text, fontWeight: "600" },
    sheetContent: { paddingHorizontal: 16, paddingBottom: 40, gap: 10 },
    swipeContainer: {
      borderRadius: 14,
      borderCurve: "continuous",
      overflow: "hidden",
      position: "relative",
    },
    deleteBackdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.danger,
      flexDirection: "row",
      alignItems: "center",
      paddingLeft: 20,
      gap: 8,
    },
    deleteText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
    rowFront: {
      backgroundColor: theme.bubble,
      borderRadius: 14,
      borderCurve: "continuous",
    },
    rowPressable: { padding: 14, gap: 8 },
    metaRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
    kindTag: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
    },
    kindTagText: { fontSize: 11, fontWeight: "600" },
    ruleTag: { backgroundColor: "rgba(0, 122, 255, 0.15)" },
    ruleTagText: { color: "#0A84FF" },
    factTag: { backgroundColor: "rgba(52, 199, 89, 0.15)" },
    factTagText: { color: theme.green },
    sharedTag: {
      backgroundColor: "rgba(175, 82, 222, 0.15)",
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
    },
    sharedTagText: { color: "#BF5AF2", fontSize: 11, fontWeight: "600" },
    tentativeTag: {
      backgroundColor: "rgba(255, 149, 0, 0.15)",
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
    },
    tentativeTagText: { color: "#FF9F0A", fontSize: 11, fontWeight: "600" },
    dateText: { color: theme.muted, fontSize: 12, marginLeft: "auto" },
    factBody: { color: theme.text, fontSize: 14, lineHeight: 21 },
    rowFooter: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 2,
    },
    expandHint: { color: theme.muted, fontSize: 11 },
    readerButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 2,
      paddingHorizontal: 6,
    },
    readerButtonText: { color: theme.link, fontSize: 12, fontWeight: "500" },
    emptyState: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 50,
      paddingHorizontal: 32,
      gap: 10,
    },
    emptyTitle: { color: theme.text, fontSize: 17, fontWeight: "600" },
    emptyDesc: { color: theme.muted, fontSize: 13, textAlign: "center", lineHeight: 18 },
    error: { color: theme.danger, fontSize: 14, marginHorizontal: 4 },
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0, 0, 0, 0.65)",
      justifyContent: "center",
      alignItems: "center",
      padding: 20,
    },
    modalCard: {
      width: "100%",
      maxHeight: "80%",
      backgroundColor: theme.bg,
      borderRadius: 20,
      borderCurve: "continuous",
      padding: 18,
      gap: 14,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 20,
      elevation: 10,
    },
    modalHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.line,
      paddingBottom: 12,
    },
    modalMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
    modalScroll: { maxHeight: 350 },
    modalBody: { color: theme.text, fontSize: 16, lineHeight: 24 },
    modalFooter: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.line,
      paddingTop: 12,
    },
    copyButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      backgroundColor: theme.bubble,
    },
    copyText: { color: theme.text, fontSize: 14, fontWeight: "500" },
    doneButton: {
      paddingVertical: 8,
      paddingHorizontal: 18,
      borderRadius: 10,
      backgroundColor: theme.control,
    },
    doneText: { color: theme.text, fontSize: 14, fontWeight: "600" },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
