import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { pressableStyle } from "./pressableStyles";

/** Tappable card (account menu entries, inbox rows). */
export function CardButton({
  onPress,
  onLongPress,
  children,
  style,
  disabled,
}: {
  onPress: () => void;
  onLongPress?: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={(state) =>
        pressableStyle([styles.card, state.pressed && !disabled ? styles.cardPressed : null, style], {
          ...state,
          disabled,
        })
      }
    >
      {children}
    </Pressable>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  cardPressed: { backgroundColor: colors.pressed },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
