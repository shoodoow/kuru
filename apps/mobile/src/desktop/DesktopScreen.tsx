import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { createCore } from "../api";
import type { RosterAgent } from "../api";
import { authClient } from "../auth";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar } from "../ui/Avatar";
import { CircleButton } from "../ui/CircleButton";
import { IconHelp, IconKeyboard, IconMore } from "../ui/icons";
import { DesktopInputMenu } from "./DesktopInputMenu";
import { getTrackpadMode, setTrackpadMode } from "./desktopPrefs";
import { TrackpadCapture } from "./TrackpadCapture";

const core = createCore();

/** Keysym codes the shell understands, for the keys a phone lacks. */
const KEYSYM_BACKSPACE = 0xff08;
const KEYSYM_RETURN = 0xff0d;

/**
 * Shows one agent's desktop.
 *
 * The pixel stream is noVNC's: the core serves a page that runs the real
 * client in a WebView, which negotiates Tight/ZRLE and paints to a canvas
 * instead of re-encoding every frame as a PNG data URI in JS. That buys the
 * encodings the handwritten reader could not decode, plus wheel, right-click,
 * clipboard, and reconnect.
 *
 * Input: the account id, the agent, and navigation plus error handlers.
 * Output: the live screen, take-over, and hand-back controls.
 */
export function DesktopScreen({
  accountId,
  agent,
  onApprovals,
  onError,
}: {
  accountId: string;
  agent: RosterAgent;
  onBack: () => void;
  onApprovals: () => void;
  onError: (error: unknown) => void;
}) {
  useResolvedScheme();
  const profile = agent.linuxProfile ?? "";
  const [live, setLive] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [typed, setTyped] = useState("");
  const [page, setPage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [trackpad, setTrackpad] = useState(false);
  const [prefsReady, setPrefsReady] = useState(false);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const inputRef = useRef<TextInput>(null);
  const trackpadRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getTrackpadMode().then((enabled) => {
      if (!cancelled) {
        trackpadRef.current = enabled;
        setTrackpad(enabled);
        setPrefsReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyTrackpad = useCallback((enabled: boolean) => {
    webRef.current?.injectJavaScript(
      `window.nanoSetTrackpad && window.nanoSetTrackpad(${enabled}); true;`,
    );
  }, []);

  const recenterPointer = useCallback(() => {
    webRef.current?.injectJavaScript(`window.nanoRecenterPointer && window.nanoRecenterPointer(); true;`);
  }, []);

  // HTTPS cores use HttpOnly session cookies; the WebView cannot plant them for
  // the screen socket, so fetch a short-lived ws token with the app session first.
  useEffect(() => {
    if (!profile || !prefsReady) {
      if (!profile) {
        setPage("");
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { token } = await core.getScreenToken(accountId, profile);
        if (cancelled) {
          return;
        }
        const viewer = `${core.screenPageUrl(accountId, profile)}?${new URLSearchParams({
          url: core.screenUrl(accountId, profile, token),
          viewOnly: "0",
          trackpad: trackpadRef.current ? "1" : "0",
        }).toString()}`;
        setPage(viewer);
      } catch (error) {
        if (!cancelled) {
          onError(error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, profile, onError, prefsReady]);

  // The WebView keeps its own cookie jar and the expo client keeps the session
  // in SecureStore, so the cookie has to be copied across before the viewer can
  // open its socket. It is planted on page load as well as before content load:
  // on iOS the pre-load injection runs in a document whose origin is not yet
  // committed, and a cookie written there is thrown away.
  //
  // The value is interpolated here rather than read from a closure, because
  // injected JavaScript runs in the WebView's realm where the app's module scope
  // does not exist. Raising __nanoSessionReady is what tells the viewer it may
  // connect.
  const seed = authClient.getCookie();
  const planted = seed ? "window.__nanoSessionReady = true;" : "window.__nanoNoSession = true;";
  const injected = `${planted} true;`;
  const webSource = seed ? { uri: page, headers: { Cookie: seed } } : { uri: page };

  const sendKey = useCallback((keysym: number) => {
    // Omitting `down` makes noVNC send a press followed by a release; passing
    // true would leave the key stuck down. An empty code means no scancode, so
    // noVNC sends a plain keysym event, which is all x11vnc needs for ordinary
    // characters. noVNC ignores this while the viewer is view-only.
    webRef.current?.injectJavaScript(
      `window.nanoRfb && window.nanoRfb.sendKey(${keysym}, ""); true;`,
    );
  }, []);

  // Watching is controlling, so the agent's own mouse and keyboard pause while
  // the screen is open and resume on the way out.
  useEffect(() => {
    if (!profile) {
      return;
    }
    void core.takeOver(accountId, profile).catch(() => {});
    return () => {
      void core.handBack(accountId, profile).catch(() => {});
    };
  }, [accountId, profile]);

  function onMessage(event: WebViewMessageEvent): void {
    let payload: { kind?: string; message?: string };
    try {
      payload = JSON.parse(event.nativeEvent.data) as { kind?: string; message?: string };
    } catch {
      return;
    }
    if (payload.kind === "connect") {
      setLive(true);
      applyTrackpad(trackpadRef.current);
    } else if (payload.kind === "disconnect") {
      setLive(false);
    } else if (payload.kind === "error") {
      setLive(false);
      onError(new Error(payload.message ?? "The desktop connection failed."));
    } else if (payload.kind === "auth") {
      // The viewer reached the core but the socket was refused, which means the
      // page loaded without a usable session cookie. Say so instead of sitting
      // on "Connecting" forever.
      setLive(false);
      onError(new Error("Sign in again to watch this screen."));
    }
  }

  function typeText(next: string): void {
    if (next.length < typed.length) {
      // The phone keyboard edits the whole field, so remove exactly as many
      // characters as were removed, not just one.
      for (let i = 0; i < typed.length - next.length; i++) {
        sendKey(KEYSYM_BACKSPACE);
      }
    } else {
      for (const char of next.slice(typed.length)) {
        sendKey(char === "\n" ? KEYSYM_RETURN : char.charCodeAt(0));
      }
    }
    setTyped(next);
  }

  function toggleTrackpad(): void {
    const next = !trackpadRef.current;
    trackpadRef.current = next;
    setTrackpad(next);
    applyTrackpad(next);
    void setTrackpadMode(next).catch(() => {});
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.headerTitle}>
          <Avatar
            id={agent.id}
            size={22}
            round
            shape={agent.markShape}
            color={agent.markColor}
            material={agent.markMaterial}
            style={agent.markStyle}
            gender={agent.markGender}
            photo={agent.avatarUrl}
          />
          <Text style={styles.name} numberOfLines={1}>
            {agent.name}
          </Text>
        </View>
      ),
      headerRight: () => (
        <View style={styles.headerSide}>
          <Pressable
            accessibilityLabel="About this screen"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() =>
              Alert.alert(
                "Desktop",
                (trackpad
                  ? "Trackpad mode: drag to move the pointer, tap to click. Tap, then drag, to hold the button down (select text, move a window)."
                  : "Direct touch: tap to click the spot under your finger, drag to hold the button down. Turn on trackpad mode in the menu for a laptop-style pointer.") +
                  "\n\nRight click: press and hold, or tap with two fingers.\nScroll: drag with two fingers.\nZoom: pinch. While zoomed in, two fingers also slide the view.",
              )
            }
            style={styles.headerHit}
          >
            <IconHelp />
          </Pressable>
          <Pressable
            accessibilityLabel="Desktop options"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setMenuOpen((open) => !open)}
            style={styles.headerHit}
          >
            <IconMore />
          </Pressable>
        </View>
      ),
    });
  }, [agent, navigation, trackpad]);

  return (
    <View style={styles.screen}>
      {menuOpen ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={() => setMenuOpen(false)}
            style={styles.menuScrim}
          />
          <View style={styles.menuCard}>
            <DesktopInputMenu
              trackpad={trackpad}
              onToggleTrackpad={toggleTrackpad}
              onRecenterPointer={recenterPointer}
              onResetZoom={() => webRef.current?.injectJavaScript(`window.nanoResetZoom && window.nanoResetZoom(); true;`)}
              onApprovals={onApprovals}
              onClose={() => setMenuOpen(false)}
            />
          </View>
        </>
      ) : null}
      <View style={styles.stage}>
        {page ? (
          <WebView
            ref={webRef}
            source={webSource}
            // Kept apart from the app's own cookie store: sharing it left this
            // account's session behind, where it was then sent with requests
            // made for a different signed-in account.
            sharedCookiesEnabled={false}
            originWhitelist={["http://*", "https://*"]}
            injectedJavaScriptBeforeContentLoaded={injected}
            // Planting the cookie again once the page is loaded is what makes
            // this work on iOS, where the pre-load injection above lands before
            // the document has an origin.
            onLoadEnd={() => {
              webRef.current?.injectJavaScript(injected);
            }}
            onMessage={onMessage}
            onError={() => onError(new Error("The desktop viewer failed to load."))}
            androidLayerType="hardware"
            allowsInlineMediaPlayback
            style={styles.viewer}
            // The viewer page handles every gesture itself, pinch zoom included,
            // so the WebView around it must not pan or zoom as well.
            scrollEnabled={false}
            bounces={false}
            setBuiltInZoomControls={false}
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
            overScrollMode="never"
          />
        ) : null}
        {page && trackpad && live ? <TrackpadCapture webRef={webRef} /> : null}
        {!page ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>This agent has no desktop yet.</Text>
          </View>
        ) : null}
        <Text style={[styles.status, live ? styles.live : null]} pointerEvents="none">
          {profile ? (live ? "Live" : "Connecting") : "No desktop"}
        </Text>
      </View>
      {/* Off-screen so no field shows on screen; the keyboard button focuses it
          to raise the soft keyboard, and each change is forwarded as keysyms. */}
      <TextInput
        ref={inputRef}
        value={typed}
        onChangeText={typeText}
        onFocus={() => setKeyboard(true)}
        onBlur={() => {
          setKeyboard(false);
          setTyped("");
        }}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        returnKeyType="send"
        blurOnSubmit={false}
        onSubmitEditing={() => sendKey(KEYSYM_RETURN)}
        style={styles.hidden}
      />
      <View style={[styles.footer, { paddingBottom: Math.max(18, insets.bottom) }]}>
        <CircleButton
          label={keyboard ? "Hide keyboard" : "Keyboard"}
          onPress={() => {
            if (keyboard) {
              inputRef.current?.blur();
            } else {
              inputRef.current?.focus();
            }
          }}
        >
          <IconKeyboard />
        </CircleButton>
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerTitle: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 220 },
  headerSide: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerHit: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  name: { color: colors.text, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  stage: { flex: 1, backgroundColor: "#111" },
  viewer: { flex: 1, alignSelf: "stretch", backgroundColor: "#111" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: "#ddd", fontSize: 14 },
  status: { position: "absolute", bottom: 16, left: 0, right: 0, textAlign: "center", color: "#ddd", fontSize: 13 },
  live: { color: "#7ddc7d" },
  hidden: { position: "absolute", top: 0, left: 0, width: 1, height: 1, opacity: 0 },
  footer: { flexDirection: "row", justifyContent: "center", paddingHorizontal: 16, paddingVertical: 18 },
  menuCard: { position: "absolute", top: 8, right: 8, zIndex: 3 },
  menuScrim: { ...StyleSheet.absoluteFill, zIndex: 2 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
