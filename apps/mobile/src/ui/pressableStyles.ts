import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

export const interaction = {
  pressedOpacity: 0.72,
  pressedScale: 0.97,
  disabledOpacity: 0.38,
} as const;

type PressState = { pressed: boolean; disabled?: boolean };

/** Merges base styles with standard pressed/disabled feedback. */
export function pressableStyle(base: StyleProp<ViewStyle>, state: PressState): StyleProp<ViewStyle> {
  return [
    base,
    state.disabled ? styles.disabled : null,
    state.pressed && !state.disabled ? styles.pressed : null,
  ];
}

const styles = StyleSheet.create({
  pressed: { opacity: interaction.pressedOpacity, transform: [{ scale: interaction.pressedScale }] },
  disabled: { opacity: interaction.disabledOpacity },
});
