import { Dimensions, useWindowDimensions } from "react-native";

/** Narrower than this, a browser window gets the phone layout. */
const WIDE_FROM = 900;

/**
 * True when the app should lay itself out for a desktop window: agents down
 * the left edge, the chat in the middle, the agent's details on the right.
 * Only a browser (and later the desktop app built around it) is ever wide;
 * a phone or tablet keeps one screen at a time.
 */
export function useWideLayout(): boolean {
  const { width } = useWindowDimensions();
  return process.env.EXPO_OS === "web" && width >= WIDE_FROM;
}

/** The same answer for code that runs outside a component. */
export function isWideLayout(): boolean {
  return process.env.EXPO_OS === "web" && Dimensions.get("window").width >= WIDE_FROM;
}
