import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { AdaptiveSurface } from "../ui/AdaptiveSurface";
import { ContextUsageRing } from "../ui/ContextUsageRing";
import { KeyboardLift } from "../ui/KeyboardLift";
import { IconCollapse, IconDismiss, IconExpand } from "../ui/icons";
import { SendButton } from "./SendButton";

const LINE_HEIGHT = 22;
/** Vertical padding inside the box; one line plus both pads is the 44pt rest height. */
const PADDING_Y = 11;
const MIN_HEIGHT = LINE_HEIGHT + PADDING_Y * 2;
const MAX_LINES = 6;
const MAX_HEIGHT = LINE_HEIGHT * MAX_LINES + PADDING_Y * 2;

/**
 * The message field, Telegram style.
 * Why: it rests at one line, grows a line at a time with the text, and stops
 * at six lines. The field sizes itself from its text (no measured height fed
 * back through state), so the box never lags a keystroke behind. Past the cap
 * the text scrolls inside and an expand button opens a full-screen editor for
 * long briefs; both edit the same draft.
 * A message being replied to shows as a card inside the same box, above the
 * text, so the reply and what it answers read as one thing.
 * Input: draft + change handler, placeholder, optional context ring, the
 * reply's first line (null = not replying), send.
 * Output: the field, and the full-screen editor while it is open.
 */
export function Composer({
  value,
  onChange,
  placeholder,
  contextRing,
  replyText,
  onClearReply,
  canSend,
  sending,
  onSend,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  contextRing?: { share: number; hint: string } | null;
  replyText?: string | null;
  onClearReply?: () => void;
  canSend: boolean;
  sending: boolean;
  onSend: () => void;
}) {
  const insets = useSafeAreaInsets();
  // True once the text is taller than the cap: scrolling turns on and the
  // expand button shows. Scrolling stays off below it so growing never jumps.
  const [capped, setCapped] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  // Sending clears the draft; drop back to one line even if no size event follows.
  useEffect(() => {
    if (value.length === 0) setCapped(false);
  }, [value]);

  return (
    <AdaptiveSurface style={styles.surface}>
      {replyText ? (
        <View style={styles.reply}>
          <View style={styles.replyBody}>
            <Text style={styles.replyLabel}>Replying</Text>
            <Text style={styles.replyText} numberOfLines={1}>
              {replyText}
            </Text>
          </View>
          <Pressable
            style={styles.replyClose}
            hitSlop={8}
            onPress={onClearReply}
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
          >
            <IconDismiss />
          </Pressable>
        </View>
      ) : null}
      {/* The buttons pin to this row, not the whole box, so the card above never moves them. */}
      <View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, contextRing || capped ? styles.inputWithSide : null]}
        multiline
        // A long placeholder wraps in a multiline field and makes the empty
        // box two lines tall, so it stays one short word.
        maxLength={20000}
        scrollEnabled={capped}
        textAlignVertical="top"
        // A browser: the field starts one line tall, Enter sends, and Shift+Enter starts a new line.
        {...(process.env.EXPO_OS === "web"
          ? {
              rows: 1,
              onKeyPress: (event: { nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean }; preventDefault: () => void }) => {
                const key = event.nativeEvent;
                if (key.key !== "Enter" || key.shiftKey || key.isComposing) return;
                event.preventDefault();
                if (canSend) onSend();
              },
            }
          : null)}
        onContentSizeChange={(event) => {
          setCapped(event.nativeEvent.contentSize.height > LINE_HEIGHT * MAX_LINES + 2);
        }}
      />
      {capped ? (
        <Pressable
          style={styles.expand}
          hitSlop={6}
          onPress={() => setFullScreen(true)}
          accessibilityRole="button"
          accessibilityLabel="Edit full screen"
        >
          <IconExpand />
        </Pressable>
      ) : null}
      {contextRing ? (
        <View style={styles.ring} pointerEvents="box-none">
          <ContextUsageRing share={contextRing.share} hint={contextRing.hint} />
        </View>
      ) : null}
      </View>
      {/* Full screen, not a page sheet: a sheet sits below the top of the
          window, which throws the keyboard padding off by that gap. */}
      <Modal visible={fullScreen} animationType="slide" onRequestClose={() => setFullScreen(false)}>
        <KeyboardLift style={styles.editorShell}>
          <View style={[styles.editor, { paddingTop: insets.top }]}>
            <View style={styles.editorBar}>
              <Pressable
                style={styles.editorClose}
                hitSlop={8}
                onPress={() => setFullScreen(false)}
                accessibilityRole="button"
                accessibilityLabel="Back to chat"
              >
                <IconCollapse />
              </Pressable>
              <Text style={styles.editorTitle} numberOfLines={1}>
                {placeholder}
              </Text>
<SendButton
                disabled={!canSend}
                busy={sending}
                onPress={() => {
                  setFullScreen(false);
                  onSend();
                }}
              />
            </View>
            <TextInput
              value={value}
              onChangeText={onChange}
              placeholder={placeholder}
              placeholderTextColor={colors.muted}
              style={styles.editorInput}
              multiline
              autoFocus
              maxLength={20000}
              textAlignVertical="top"
            />
          </View>
        </KeyboardLift>
      </Modal>
    </AdaptiveSurface>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    surface: { flex: 1, borderRadius: 22, borderCurve: "continuous", overflow: "hidden" },
    input: {
      minHeight: MIN_HEIGHT,
      maxHeight: MAX_HEIGHT,
      color: colors.text,
      paddingHorizontal: 16,
      paddingTop: PADDING_Y,
      paddingBottom: PADDING_Y,
      fontSize: 16,
      lineHeight: LINE_HEIGHT,
      backgroundColor: "transparent",
    },
    inputWithSide: { paddingRight: 40 },
    reply: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
      marginHorizontal: 6,
      paddingVertical: 8,
      paddingLeft: 12,
      paddingRight: 6,
      backgroundColor: colors.control,
      borderRadius: 16,
      borderCurve: "continuous",
    },
    replyBody: { flex: 1, gap: 1 },
    replyLabel: { color: colors.muted, fontSize: 13 },
    replyText: { color: colors.text, fontSize: 15 },
    replyClose: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    expand: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    // Pinned to the last line, so it stays put while the box grows upward.
    ring: {
      position: "absolute",
      right: 12,
      bottom: 0,
      height: MIN_HEIGHT,
      justifyContent: "center",
    },
    editorShell: { flex: 1, backgroundColor: colors.bg },
    editor: { flex: 1, backgroundColor: colors.bg },
    editorBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    editorClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    editorTitle: { flex: 1, color: colors.muted, fontSize: 15 },
    editorInput: {
      flex: 1,
      color: colors.text,
      fontSize: 17,
      lineHeight: 24,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 14,
    },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
