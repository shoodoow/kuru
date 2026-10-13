import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

/**
 * Keeps a screen's bottom edge (a composer, a row of buttons) above the keyboard.
 * Input: `absorb` is the room the screen already leaves at its bottom for the
 * home indicator or the navigation bar. The keyboard covers that room, so it
 * is taken off the lift and the content rests right on the keyboard.
 * `slide` (iOS) moves the content with the keyboard and settles into padding,
 * which suits a chat; without it the content is padded.
 * Output: a view that fills its parent and lifts with the keyboard.
 *
 * Why Android is done by hand: the library's own view works out the lift from
 * where it sits on screen. On Android that lookup did not account for the
 * header above the screen, so the lift came out one header short and the
 * message field ended up under the keyboard. Here the lift is simply the
 * keyboard's height, which needs no position. It relies on the view reaching
 * the bottom of the window, which is true of every screen that uses it.
 */
export function KeyboardLift({
  absorb = 0,
  slide = false,
  style,
  children,
}: {
  absorb?: number;
  slide?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  if (process.env.EXPO_OS === "android") {
    return (
      <AndroidLift absorb={absorb} style={style}>
        {children}
      </AndroidLift>
    );
  }
  return (
    <KeyboardAvoidingView
      style={style}
      behavior={slide ? "translate-with-padding" : "padding"}
      automaticOffset
      keyboardVerticalOffset={-absorb}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

function AndroidLift({ absorb, style, children }: { absorb: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  // Runs from 0 to minus the keyboard's height, frame by frame on the UI thread.
  const { height } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -height.value - absorb) }));
  return <Animated.View style={[style, lift]}>{children}</Animated.View>;
}
