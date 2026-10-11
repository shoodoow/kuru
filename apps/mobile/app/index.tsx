import { useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useNavigation } from "expo-router";
import { InboxScreen } from "../src/inbox/InboxScreen";
import { SetupGuide } from "../src/inbox/SetupGuide";
import { WelcomeScreen } from "../src/inbox/WelcomeScreen";
import { useSession } from "../src/session/SessionProvider";
import { Avatar } from "../src/ui/Avatar";
import { IconPlus, IconSearch } from "../src/ui/icons";
import { colors } from "../src/theme/tokens";
import { Toast } from "../src/ui/Toast";

export default function InboxRoute() {
  const navigation = useNavigation();
  const session = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [searching, setSearching] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      // The welcome page has the screen to itself.
      headerShown: Boolean(session.account),
      headerLeft: () => (
        <Pressable
          accessibilityLabel="Account"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            const current = sessionRef.current;
            if (!current.account) {
              current.openAccount("signup");
              return;
            }
            current.openAccount("menu");
          }}
          style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
        >
          <Avatar
            id={sessionRef.current.account?.id ?? "account"}
            size={30}
            person
            label={sessionRef.current.account?.name}
            photo={sessionRef.current.account?.image}
          />
        </Pressable>
      ),
      headerRight: () => (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {sessionRef.current.pendingCount > 0 ? (
            <View
              accessibilityLabel={`${sessionRef.current.pendingCount} unread pings`}
              style={{
                backgroundColor: colors.danger,
                borderRadius: 11,
                minWidth: 22,
                height: 22,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                {sessionRef.current.pendingCount > 99 ? "99+" : String(sessionRef.current.pendingCount)}
              </Text>
            </View>
          ) : null}
          <Pressable
            accessibilityLabel="Search"
            accessibilityRole="button"
            accessibilityState={{ selected: searching }}
            hitSlop={8}
            onPress={() => setSearching((open) => !open)}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <IconSearch />
          </Pressable>
          <Pressable
            accessibilityLabel="New chat"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => sessionRef.current.openNewRoom()}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <IconPlus />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, searching, session.pendingCount, session.account]);

  // Nobody signed in: say hello and put sign-in on the page.
  if (!session.account) {
    if (!session.restored) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
    return (
      <>
        <WelcomeScreen
          serverUrl={session.serverUrl}
          onSignIn={() => session.signInWithGoogle()}
          onChangeServer={() => session.openAccount("signup")}
        />
        <Toast />
      </>
    );
  }

  // A new account has no agent to talk to until a provider and a model are chosen.
  if (session.account && session.setupNeeded) {
    return (
      <>
        <SetupGuide
          providers={session.providers}
          onFinish={(provider, secret, baseUrl, modelId) => session.finishSetup(provider, secret, baseUrl, modelId)}
          onError={session.show}
        />
        <Toast />
      </>
    );
  }

  return (
    <>
    <InboxScreen
      agents={session.agents}
      groups={session.groups}
      status={session.inbox}
      searching={searching}
      onOpenGroup={(id) => void session.openGroup(id).catch(session.show)}
      onOpen={(agent) => void session.openAgent(agent).catch(session.show)}
      onPin={(agent) => void session.setRosterFlag(agent, { pinned: !agent.pinned }).catch(session.show)}
      onHide={(agent) => void session.setRosterFlag(agent, { hidden: true }).catch(session.show)}
      note={session.note}
    />
    {/* Errors already print in the inbox's own line. */}
    <Toast tones={["success"]} />
    </>
  );
}
