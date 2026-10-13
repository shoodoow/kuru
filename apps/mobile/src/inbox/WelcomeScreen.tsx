import { randomSurpriseMark } from "@kuru/shared";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar } from "../ui/Avatar";
import { PrimaryButton } from "../ui/PrimaryButton";

/** "Good morning", "Good afternoon" or "Good evening", by the phone's clock. */
function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/**
 * The first page a person sees before signing in.
 * Why: the app used to open on an empty list with one line of grey text, and
 * the only way in was the small account button in the corner. This says hello,
 * shows one of the agents' faces (a new one each visit; tap for another), says
 * what the app is for, and puts sign-in on the page.
 * Input: the sign-in action, the server in use, and a way to change it.
 * Output: the welcome page.
 */
export function WelcomeScreen({
  serverUrl,
  notice,
  onSignIn,
  onChangeServer,
}: {
  /** Shown when the app or the server needs updating before sign-in can work well. */
  notice?: string | null;
  serverUrl: string;
  onSignIn: () => Promise<void>;
  onChangeServer: () => void;
}) {
  useResolvedScheme();
  const insets = useSafeAreaInsets();
  const [look, setLook] = useState(() => randomSurpriseMark());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: Math.max(24, insets.bottom + 12) }]}>
      <View style={styles.hero}>
        <Pressable accessibilityRole="button" accessibilityLabel="Show another face" onPress={() => setLook(randomSurpriseMark())}>
          <Avatar
            id="welcome"
            size={148}
            shape={look.markShape}
            color={look.markColor}
            material={look.markMaterial}
            style={look.markStyle}
            gender={look.markGender}
          />
        </Pressable>
        <Text style={styles.greeting}>{greeting()}</Text>
        <Text style={styles.title}>Welcome</Text>
        <Text style={styles.body}>
          Build a team of AI agents that work for you: each with its own chat, its own computer, and a memory of how you like things done.
        </Text>
      </View>
      <View style={styles.actions}>
        <PrimaryButton
          label="Continue with Google"
          busy={busy}
          onPress={() => {
            setBusy(true);
            setError(null);
            void onSignIn()
              .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Sign-in did not finish."))
              .finally(() => setBusy(false));
          }}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice && !error ? <Text style={styles.error}>{notice}</Text> : null}
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onChangeServer} style={styles.server}>
          <Text style={styles.serverText} numberOfLines={1}>
            Server: {serverUrl.replace(/^https?:\/\//, "")} · Change
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 24 },
    hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
    greeting: { color: colors.muted, fontSize: 16, marginTop: 14 },
    title: { color: colors.text, fontSize: 34, fontWeight: "700" },
    body: { color: colors.muted, fontSize: 16, lineHeight: 23, textAlign: "center", maxWidth: 340 },
    actions: { gap: 12 },
    error: { color: colors.danger, fontSize: 14, textAlign: "center" },
    server: { alignSelf: "center", paddingVertical: 4 },
    serverText: { color: colors.muted, fontSize: 13 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
