import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { servedByCore } from "./core-url";

/**
 * Deep link Better Auth should redirect to after Google OAuth.
 * Expo Go must use exp:// so Chrome custom tabs can return to the running app.
 */
export function authCallbackURL(): string {
  if (Platform.OS === "web") {
    // Back to the app, which sits at /app when the server serves it.
    return `${globalThis.location.origin}${servedByCore() ? "/app" : ""}`;
  }
  if (Constants.appOwnership === "expo") {
    return Linking.createURL("/");
  }
  return Linking.createURL("/", { scheme: "kuru" });
}
