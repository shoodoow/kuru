import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Room for the Android navigation bar at the bottom of a page.
 * Why: Android draws the app edge to edge, so the last row of a page sat
 * under the system buttons and could not be scrolled into reach. iOS scroll
 * views already add this room themselves, so there it is nothing.
 * Input: none. Output: a style to add to the page's outer view, or null.
 */
export function useNavBarPad(): { paddingBottom: number } | null {
  const insets = useSafeAreaInsets();
  return process.env.EXPO_OS === "android" && insets.bottom > 0 ? { paddingBottom: insets.bottom } : null;
}
