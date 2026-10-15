import { useEffect, useLayoutEffect } from "react";
import { useNavigation } from "expo-router";
import { HeaderBackButton, useHeaderHeight } from "expo-router/react-navigation";
import { MenuSheet, type MenuPage } from "../src/account/MenuSheet";
import { ApprovalsScreen } from "../src/approvals/ApprovalsScreen";
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
  approvals: "Approvals",
  models: "Models",
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
  const headerHeight = useHeaderHeight();
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
        notifications={session.notifications}
        autoReview={session.autoReview}
        autoTimeZone={session.autoTimeZone}
        timeZone={session.timeZone}
        providers={session.providers}
        plugins={session.plugins}
        agents={session.agents}
        onError={session.show}
        serverUrl={session.serverUrl}
        onChangeServer={session.changeServer}
        onLoadUsage={(period) => core.usage(session.accountId.trim(), period)}
        onPage={(page) => {
          session.setMenu(page);
          if (page === "plugins") void session.refreshPlugins().catch(session.show);
        }}
        onNotifications={session.setNotifications}
        onAutoReview={(value) => void session.persistAutoReview(value).catch(session.show)}
        onAutoTimeZone={session.setAutoTimeZone}
        onApprovals={() => session.setMenu("approvals")}
        approvalsPage={
          <ApprovalsScreen
            proposals={session.proposals}
            toolApprovals={session.toolApprovals}
            onApprove={(id) => void session.refreshProposals(id, true).catch(session.show)}
            onReject={(id) => void session.refreshProposals(id, false).catch(session.show)}
            onApproveTool={(id, always) => void session.decideToolRow(id, true, always).catch(session.show)}
            onDenyTool={(id) => void session.decideToolRow(id, false).catch(session.show)}
            onReload={session.reloadApprovals}
            onLoadAllowances={() => core.listAllowances(session.accountId.trim())}
            onRemoveAllowance={(id) => core.removeAllowance(session.accountId.trim(), id)}
            onBack={() => session.setMenu("menu")}
          />
        }
        onComputer={() => {
          const agent = session.agents.find((row) => row.linuxProfile) ?? session.agents[0];
          if (agent) session.openDesktop(agent);
        }}
        // The provider page reports a refused key or model itself, under the button that was pressed.
        onSaveProvider={session.saveProvider}
        defaultModel={session.defaultModel}
        onSaveDefaultModel={session.saveDefaultModel}
        cheapModel={session.cheapModel}
        onSaveCheapModel={session.saveCheapModel}
        onAddPlugin={(id) => void session.addPlugin(id).catch(session.show)}
        onRemovePlugin={session.removePlugin}
        onRefreshPlugins={() => void session.refreshPlugins().catch(session.show)}
        onSaveCustomPlugin={(name, url, secret) => session.saveCustomPlugin(name, url, secret).catch(session.show)}
        onSignInCustomPlugin={(name, url) => void session.signInCustomPlugin(name, url).catch(session.show)}
        onGoogle={() => void session.signInWithGoogle().catch(session.show)}
        accounts={session.accounts}
        onSwitch={session.switchAccount}
        onAdd={session.addAccount}
        onSignOut={session.signOut}
        onDelete={session.deleteAccount}
      />
      {/* Only the iOS sheet puts its content behind the header; elsewhere it starts below. */}
      <Toast top={process.env.EXPO_OS === "ios" ? headerHeight : 0} />
    </View>
  );
}
