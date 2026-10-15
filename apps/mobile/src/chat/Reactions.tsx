import { useEffect, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { allowedEmojis } from "@kuru/shared";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import type { Reaction } from "../api";

// Two rows of six in the hold sheet. The server accepts a few more (see emojiTones).
export const SHEET_EMOJI = ["👍", "👎", "❤️", "😂", "🎉", "😮", "🔥", "👀", "🙏", "😢", "💯", "👏"].filter((emoji) =>
  (allowedEmojis as readonly string[]).includes(emoji),
);

/** One row in the hold sheet; rows with the same group share a rounded box. */
export type MessageAction = { label: string; icon: ReactNode; onPress: () => void; group?: number };
/** Where a bubble sits in the window, from measureInWindow. */
export type BubbleFrame = { x: number; y: number; width: number; height: number };

/**
 * Shows the tapbacks already on a message as small chips.
 * Nothing renders for a message with no reactions, so holding a bubble never
 * changes its height. Tapping a chip adds or removes your own reaction.
 * Input: reactions + pick callback. Output: the chips row, or nothing.
 */
export function ReactionChips({ reactions, onPick }: { reactions: Reaction[]; onPick: (emoji: string) => void }) {
  const grouped = new Map<string, number>();
  for (const reaction of reactions) grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + 1);
  if (grouped.size === 0) return null;
  return (
    <View style={styles.chipsRow}>
      {[...grouped.entries()].map(([emoji, count]) => (
        <Pressable
          key={emoji}
          style={styles.chip}
          hitSlop={4}
          onPress={() => onPick(emoji)}
          accessibilityRole="button"
          accessibilityLabel={`${emoji} ${count}`}
        >
          <Text style={styles.chipEmoji}>{emoji}</Text>
          {count > 1 ? <Text style={styles.count}>{count}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const PER_ROW = 6;
const KEY_GAP = 12;
/** Hidden below the screen before it slides up, and when it is dragged away. */
const OFF = 700;

/**
 * The hold menu, as a sheet from the bottom: two rows of emoji, then the
 * actions in rounded groups (Reply; Copy and Select Text).
 * Why: the floating bar and menu beside the bubble could not fit more than six
 * emoji, and on a tall message they covered it. A sheet has room for a full
 * set and sits in the same place every time, under the thumb.
 * Drag it down or tap outside to close it.
 * Input: whether it is open, the actions (each with its group), and what
 * picking an emoji and closing do. Output: the sheet over a dimmed screen.
 */
export function MessageMenu({
  open,
  actions,
  onPick,
  onClose,
}: {
  open: boolean;
  actions: MessageAction[];
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const drop = useSharedValue(OFF);
  useEffect(() => {
    if (open) drop.set(withTiming(0, { duration: 260 }));
    else drop.set(OFF);
  }, [open, drop]);
  const close = (): void => {
    drop.set(withTiming(OFF, { duration: 200 }));
    setTimeout(onClose, 180);
  };
  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .onUpdate((event) => {
      drop.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (event.translationY > 120 || event.velocityY > 900) {
        drop.set(withTiming(OFF, { duration: 180 }));
        scheduleOnRN(onClose);
      } else {
        drop.set(withTiming(0, { duration: 200 }));
      }
    });
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drop.get() }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: interpolate(drop.get(), [0, 400], [1, 0], "clamp") }));
  if (!open) return null;
  const key = Math.min(56, Math.floor((window.width - 32 - KEY_GAP * (PER_ROW - 1)) / PER_ROW));
  const groups: MessageAction[][] = [];
  for (const action of actions) {
    const at = action.group ?? 0;
    (groups[at] ??= []).push(action);
  }
  return (
    <Modal visible transparent animationType="none" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
      {/* A Modal is its own window on Android, so the drag needs its own root. */}
      <GestureHandlerRootView style={styles.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]}>
          <Pressable style={styles.fill} onPress={close} accessibilityLabel="Close menu" />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }, sheetStyle]}>
            <View style={styles.grabber} />
            <View style={[styles.emojiGrid, { gap: KEY_GAP }]}>
              {SHEET_EMOJI.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`React ${emoji}`}
                  onPress={() => onPick(emoji)}
                  style={({ pressed }) => [styles.key, { width: key, height: key, borderRadius: key / 2 }, pressed ? styles.keyPressed : null]}
                >
                  <Text style={styles.keyEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            {groups.filter(Boolean).map((group, at) => (
              <View key={at} style={styles.group}>
                {group.map((action, index) => (
                  <Pressable
                    key={action.label}
                    accessibilityRole="button"
                    onPress={action.onPress}
                    style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
                  >
                    <View style={styles.rowIcon}>{action.icon}</View>
                    <View style={[styles.rowBody, index > 0 ? styles.rowDivider : null]}>
                      <Text style={styles.rowLabel}>{action.label}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ))}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    chipsRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.control,
      borderRadius: 12,
      paddingVertical: 3,
      paddingHorizontal: 8,
    },
    chipEmoji: { fontSize: 15 },
    count: { color: colors.muted, fontSize: 12, fontWeight: "600" },
    fill: { flex: 1 },
    dim: { backgroundColor: "rgba(0,0,0,0.45)" },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.sheet,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderCurve: "continuous",
      paddingHorizontal: 16,
      paddingTop: 8,
      gap: 14,
    },
    grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 4 },
    emojiGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center" },
    key: { backgroundColor: colors.bubble, alignItems: "center", justifyContent: "center" },
    keyPressed: { backgroundColor: colors.line },
    keyEmoji: { fontSize: 26 },
    group: { backgroundColor: colors.bubble, borderRadius: 16, borderCurve: "continuous", overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, minHeight: 52 },
    rowPressed: { backgroundColor: colors.pressed },
    rowIcon: { width: 28, alignItems: "center" },
    rowBody: { flex: 1, alignSelf: "stretch", justifyContent: "center", marginLeft: 14 },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    rowLabel: { color: colors.text, fontSize: 17 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
