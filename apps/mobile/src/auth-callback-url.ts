import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

/**
 * Deep link Better Auth should redirect to after Google OAuth.
 * Expo Go must use exp:// so Chrome custom tabs can return to the running app.
 */
export function authCallbackURL(): string {
  if (Platform.OS === "web") {
    return globalThis.location.origin;
  }
  if (Constants.appOwnership === "expo") {
    return Linking.createURL("/");
  }
  return Linking.createURL("/", { scheme: "kuru" });
}
