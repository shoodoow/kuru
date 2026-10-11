import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import * as Haptics from "expo-haptics";
import { useSession } from "../session/SessionProvider";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconToastDone, IconToastWarn } from "./icons";

export type ToastMessage = { id: number; at: number; text: string; tone: "success" | "error" };

const SHOWN_MS = 2200;
/**
 * How long a message stays up. A success is a glance; an error is often a
 * whole sentence about what to fix, so it gets time to be read.
 */
function shownFor(toast: ToastMessage): number {
  return toast.tone === "success" ? SHOWN_MS : Math.min(9000, Math.max(4000, toast.text.length * 55));
}

/**
 * A short banner that drops in under the header and leaves by itself.
 * Why: "Saved." used to land in the red error line of whatever screen was
 * behind the sheet, so a success read as a failure, out of sight. Each screen
 * that can save mounts one of these; it shows the session's latest toast.
 * Input: `tones` limits what this screen shows (chat and inbox already print
 * errors inline). `top` is how far down the screen's own content starts: an
 * iOS form sheet draws its content behind its header, so a banner at the top
 * edge sat hidden there. Output: the banner, or nothing.
 */
export function Toast({ tones = ["success", "error"], top = 0 }: { tones?: ToastMessage["tone"][]; top?: number }) {
  const { toast } = useSession();
  const [shown, setShown] = useState<ToastMessage | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const wanted = toast && tones.includes(toast.tone) ? toast : null;
  useEffect(() => {
    // A screen opened later must not replay a toast that already ran.
    if (!wanted || Date.now() - wanted.at > shownFor(wanted)) return;
    setShown(wanted);
    if (process.env.EXPO_OS === "ios") {
      void Haptics.notificationAsync(
        wanted.tone === "success" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
      );
    }
    Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => setShown(null));
    }, shownFor(wanted));
    return () => clearTimeout(timer);
  }, [wanted?.id]);
  if (!shown) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        { top: top + 10, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }] },
      ]}
    >
      {shown.tone === "success" ? <IconToastDone /> : <IconToastWarn />}
      <Text style={styles.text} numberOfLines={6}>
        {shown.text}
      </Text>
    </Animated.View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    toast: {
      position: "absolute",
      top: 10,
      alignSelf: "center",
      maxWidth: "88%",
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.card,
      borderRadius: 22,
      borderCurve: "continuous",
      paddingVertical: 11,
      paddingHorizontal: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      // Above everything on its screen, form fields included.
      elevation: 12,
      boxShadow: "0 8px 20px rgba(0, 0, 0, 0.3)",
      zIndex: 10,
    },
    text: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
