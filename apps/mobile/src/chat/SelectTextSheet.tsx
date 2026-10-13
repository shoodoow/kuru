import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { PillButton } from "../ui/PrimaryButton";
import { Sheet } from "../ui/Sheet";

/** Puts text on the clipboard with the light tap that confirms it on iOS. */
export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
  if (process.env.EXPO_OS === "ios") {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }
}

/**
 * Shows one message as plain text the person can select a part of.
 * Why: a bubble is a pressable with swipe and hold gestures, so the system
 * selection handles cannot live inside it. This sheet has no gestures of its
 * own, so iOS gives the normal drag handles and Copy / Look Up menu.
 * Input: the text, or null when closed. Output: the sheet.
 */
export function SelectTextSheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
  }, [text]);
  return (
    <Sheet open={text !== null} onClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.bar}>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={styles.done}>Done</Text>
          </Pressable>
          <Text style={styles.title}>Select Text</Text>
          <PillButton
            label={copied ? "Copied" : "Copy All"}
            tone="muted"
            onPress={() => {
              void copyText(text ?? "").then(() => setCopied(true));
            }}
          />
        </View>
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
          {Platform.OS === "ios" ? (
            // A read-only multiline field is a UITextView: free range selection.
            // <Text selectable> on iOS can only copy the whole paragraph.
            <TextInput value={text ?? ""} editable={false} multiline scrollEnabled={false} style={styles.text} />
          ) : (
            <Text selectable style={styles.text}>
              {text ?? ""}
            </Text>
          )}
        </ScrollView>
      </View>
    </Sheet>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: colors.bg },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    done: { color: colors.link, fontSize: 17 },
    title: { color: colors.text, fontSize: 16, fontWeight: "600" },
    body: { paddingHorizontal: 16, paddingTop: 16 },
    text: { color: colors.text, fontSize: 17, lineHeight: 25, padding: 0 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
