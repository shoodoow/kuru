import { Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconSend } from "../ui/icons";
import { pressableStyle } from "../ui/pressableStyles";

/**
 * The send button beside the message field: an icon, as in Telegram.
 * iOS shows a white up arrow on a blue disk. Android shows a blue paper
 * plane with no disk. With nothing to send it is greyed out. While a message
 * is on its way it looks the same but ignores taps: a spinner there made a
 * quick send feel slow, and the message already shows in the chat.
 * Input: whether there is something to send, whether a send is in flight,
 * and what sending does. Output: the button, 44pt square to tap.
 */
export function SendButton({ onPress, disabled, busy }: { onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const off = disabled || busy;
  const ios = process.env.EXPO_OS === "ios";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Send"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      hitSlop={4}
      android_ripple={{ color: colors.pressed, borderless: true, radius: 22 }}
      onPress={() => {
        if (ios) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      // Greyed out by colour, not by fading: the disk keeps its shape when empty.
      style={(state) => pressableStyle(styles.hit, { pressed: state.pressed && !off })}
    >
      {ios ? (
        <View style={[styles.disk, off && !busy ? styles.diskOff : null]}>
          <IconSend color="#FFFFFF" />
        </View>
      ) : (
        <IconSend color={off && !busy ? colors.muted : colors.online} />
      )}
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    hit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    disk: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.online,
      alignItems: "center",
      justifyContent: "center",
    },
    diskOff: { backgroundColor: colors.line },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
