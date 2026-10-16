import { useEffect } from "react";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { useSession } from "../src/session/SessionProvider";
import { colors } from "../src/theme/tokens";

/**
 * Where a plugin sign-in lands (kuru://plugins) after the browser comes back from Google.
 * Opens Account on its Plugins page and reloads the list, so the new connection shows.
 */
export default function PluginsReturnRoute() {
  const router = useRouter();
  const session = useSession();

  useEffect(() => {
    session.setMenu("plugins");
    void session.refreshPlugins().catch(session.show);
    router.replace("/account");
  }, []);

  return <View style={{ flex: 1, backgroundColor: colors.sheet }} />;
}
