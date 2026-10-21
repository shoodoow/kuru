import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AgentRail } from "../src/desk/AgentRail";
import { useWideLayout } from "../src/desk/layout";
import { SessionProvider } from "../src/session/SessionProvider";
import { DotBakery } from "../src/ui/DotStage";
import { AppearanceProvider, useResolvedScheme } from "../src/theme/appearance";
import { colors } from "../src/theme/tokens";
import { OverlayHost } from "../src/ui/overlay";
import { sheetScreenOptions } from "../src/ui/sheet-screen";

// A screen that fails shows what went wrong and a Retry button, not a blank window.
export { ErrorBoundary } from "expo-router";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppearanceProvider>
        <SafeAreaProvider>
          {/* Reports the keyboard frame by frame. Each screen that has a field
              moves itself; nothing here resizes the screens underneath.
              Android already draws this app edge to edge, so the provider is
              told to leave the status and navigation bars as they are. */}
          <KeyboardProvider statusBarTranslucent navigationBarTranslucent preserveEdgeToEdge>
            <SessionProvider>
              <ThemedStack />
            </SessionProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </AppearanceProvider>
    </GestureHandlerRootView>
  );
}

function ThemedStack() {
  const dark = useResolvedScheme() === "dark";
  // A desktop window: agents down the left edge, and the screens beside them.
  const wide = useWideLayout();
  return (
    <>
      <StatusBar style={dark ? "light" : "dark"} />
      <DotBakery />
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.bg }}>
      {wide ? <AgentRail /> : null}
      <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTintColor: dark ? "#FFFFFF" : "#000000",
          headerStyle: { backgroundColor: dark ? "#000000" : "#FFFFFF" },
          headerTitleStyle: { color: dark ? "#FFFFFF" : "#000000" },
          contentStyle: { backgroundColor: colors.bg },
          // A screen that is covered stops rendering until it is shown again,
          // so typing in a chat no longer redraws the list underneath it.
          freezeOnBlur: true,
          // Panes change in place in a desktop window; nothing slides.
          ...(wide ? { animation: "none" as const } : null),
        }}
      >
        <Stack.Screen name="index" options={{ title: "Chats" }} />
        {/* iOS 26 goes back on a rightward swipe anywhere on the screen. In a
            chat that swipe belongs to a bubble (reply), so here Back is the
            swipe from the left edge only. */}
        <Stack.Screen name="chat/[conversationId]" options={{ title: "Chat", fullScreenGestureEnabled: false }} />
        {/* No swipe-back here: moving the pointer toward the right edge of the
            remote screen used to be read as "go back" and closed the desktop. */}
        <Stack.Screen name="desktop/[agentId]" options={{ title: "Desktop", gestureEnabled: false, fullScreenGestureEnabled: false }} />
        <Stack.Screen name="profile/[agentId]" options={{ title: "Profile" }} />
        <Stack.Screen name="group/[conversationId]" options={{ title: "Group" }} />
        <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
        <Stack.Screen name="account" options={sheetScreenOptions("Account")} />
        {/* The form says what it is (Chat | Group), so it carries no title bar. */}
        <Stack.Screen name="new-room" options={{ ...sheetScreenOptions("New chat"), headerShown: false }} />
      </Stack>
      </View>
      </View>
      <OverlayHost />
    </>
  );
}
