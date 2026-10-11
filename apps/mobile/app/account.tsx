import { useEffect, useLayoutEffect } from "react";
import { useNavigation } from "expo-router";
import { HeaderBackButton } from "expo-router/react-navigation";
import { MenuSheet, type MenuPage } from "../src/account/MenuSheet";
import { createCore } from "../src/api";
import { useSession } from "../src/session/SessionProvider";
import { colors } from "../src/theme/tokens";
import { View } from "react-native";
import { Toast } from "../src/ui/Toast";

const core = createCore();

const TITLES: Record<MenuPage, string> = {
  menu: "Account",
  account: "Account",
  signup: "Sign in",
  providers: "AI Providers",
  plugins: "Plugins",
  "plugin-custom": "Your MCP",
  appearance: "Appearance",
  usage: "Usage",
};

/** The menu page behind this one. Null means the account screen itself should close. */
function menuBack(page: MenuPage, signedIn: boolean): MenuPage | null {
  if (page === "menu" || (page === "signup" && !signedIn)) return null;
  if (page === "plugin-custom") return "plugins";
  if (page === "signup") return "account";
  return "menu";
}

export default function AccountRoute() {
  const navigation = useNavigation();
  const session = useSession();
  const page = session.menu ?? "menu";
  const back = menuBack(page, session.account !== null);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: TITLES[page],
      headerLeft:
        back === null
          ? () => null
          : () => <HeaderBackButton tintColor={colors.text} onPress={() => session.setMenu(back)} />,
    });
  }, [navigation, page, back, session.setMenu]);

  useEffect(() => {
    if (process.env.EXPO_OS !== "android" || back === null) return;
    return navigation.addListener("beforeRemove", (event) => {
      event.preventDefault();
      session.setMenu(back);
    });
  }, [navigation, back, session.setMenu]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.sheet }}>
      <MenuSheet
        page={session.menu ?? "menu"}
        account={session.account}
        accounts={session.accounts}
        notifications={session.notifications}
        autoReview={session.autoReview}
        autoTimeZone={session.autoTimeZone}
        timeZone={session.timeZone}
        providers={session.providers}
        plugins={session.plugins}
        agents={session.agents}
        onLoadUsage={(days) => core.usage(session.accountId.trim(), days)}
        onPage={(page) => {
          session.setMenu(page);
          if (page === "plugins") void session.refreshPlugins().catch(session.show);
        }}
        onNotifications={session.setNotifications}
        onAutoReview={(value) => void session.persistAutoReview(value).catch(session.show)}
        onAutoTimeZone={session.setAutoTimeZone}
        onApprovals={() => void session.refreshProposals().catch(session.show)}
        onComputer={() => {
          const agent = session.agents.find((row) => row.linuxProfile) ?? session.agents[0];
          if (agent) session.openDesktop(agent);
        }}
        onSaveProvider={(provider, secret, baseUrl) => session.saveProvider(provider, secret, baseUrl).catch(session.show)}
        defaultModel={session.defaultModel}
        onSaveDefaultModel={(provider, modelId) => session.saveDefaultModel(provider, modelId).catch(session.show)}
        onAddPlugin={(id) => void session.addPlugin(id).catch(session.show)}
        onRemovePlugin={session.removePlugin}
        onRefreshPlugins={() => void session.refreshPlugins().catch(session.show)}
        onSaveCustomPlugin={(name, url, secret) => session.saveCustomPlugin(name, url, secret).catch(session.show)}
        onSignInCustomPlugin={(name, url) => void session.signInCustomPlugin(name, url).catch(session.show)}
        onGoogle={() => void session.signInWithGoogle().catch(session.show)}
        onSwitch={(id) => void session.switchAccount(id).catch(session.show)}
        onSignOut={session.signOut}
        onDelete={session.deleteAccount}
      />
      <Toast />
    </View>
  );
}
