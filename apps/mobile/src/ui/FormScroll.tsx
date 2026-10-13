import type { ReactNode } from "react";
import type { ScrollViewProps } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

/**
 * A scrolling form that keeps the field being typed in above the keyboard.
 * Why: the app used to pad the whole navigation stack by the keyboard height,
 * which resized every screen under the one in use. Each form now moves only
 * itself, in step with the keyboard, on iOS and Android alike.
 * Input: ScrollView props and the form. Output: the scroll view.
 */
export function FormScroll({ children, ...props }: ScrollViewProps & { children?: ReactNode }) {
  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" {...props}>
      {children}
    </KeyboardAwareScrollView>
  );
}
