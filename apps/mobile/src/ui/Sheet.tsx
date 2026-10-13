import { useRef, type ReactElement } from "react";
import { Modal, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme/tokens";

/**
 * The app's one sheet for viewers and detail pages.
 * iOS shows the system page sheet, closed by dragging it down. Android shows a
 * page that slides up and is closed by Back or the sheet's own button.
 * Why a plain Modal: the SwiftUI/Compose bottom sheet from @expo/ui was tried
 * here and gave its React Native content no fixed height. A scroll view inside
 * it then grew to the length of its content, so it had nothing to scroll and
 * sprang back to the top whenever the finger let go. A Modal always has the
 * height of its window, so lists inside it scroll.
 * The content stays as it was while the sheet slides shut, so callers can
 * clear their state the moment they close it without the sheet going blank.
 * Input: whether it is open, what closing does, and one view that fills it.
 * Output: the sheet.
 */
export function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactElement | null;
}) {
  const insets = useSafeAreaInsets();
  const shown = useRef<ReactElement | null>(null);
  if (open && children) shown.current = children;
  const android = process.env.EXPO_OS === "android";
  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle={android ? "fullScreen" : "pageSheet"}
      // iOS calls this for the drag-down too; Android for the Back button.
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* Android draws under the status bar; the iOS sheet already starts below it. */}
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: android ? insets.top : 0 }}>{shown.current}</View>
    </Modal>
  );
}
