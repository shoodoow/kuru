import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { pressableStyle } from "./pressableStyles";
import { AdaptiveSurface } from "./AdaptiveSurface";

/**
 * Renders one round control.
 * iOS draws it as interactive glass. Android draws a Material tonal icon button.
 */
export function CircleButton({
  label,
  onPress,
  children,
  disabled,
  busy,
  active,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  active?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy, selected: active }}
      disabled={off}
      android_ripple={{ color: colors.pressed, borderless: true, radius: 22 }}
      onPress={() => {
        if (process.env.EXPO_OS === "ios") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        onPress();
      }}
      style={(state) => pressableStyle(styles.hit, { ...state, disabled: off })}
    >
      {process.env.EXPO_OS === "ios" ? (
        <AdaptiveSurface interactive style={[styles.circle, active ? styles.circleActive : null]}>
          {busy ? <ActivityIndicator color={colors.text} size="small" /> : children}
        </AdaptiveSurface>
      ) : (
        <View style={[styles.circle, styles.androidFill, active ? styles.circleActive : null]}>
          {busy ? <ActivityIndicator color={colors.text} size="small" /> : children}
        </View>
      )}
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  hit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  circle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderCurve: "continuous",
  },
  androidFill: { backgroundColor: colors.control },
  circleActive: { backgroundColor: colors.line },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
