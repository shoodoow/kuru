import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useNavigation } from "expo-router";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebFrame, type WebFrameHandle, type WebFrameMessageEvent } from "../ui/WebFrame";
import { createCore } from "../api";
import type { RosterAgent } from "../api";
import { authClient } from "../auth";
import { darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { useResolvedScheme } from "../theme/appearance";
import { Avatar } from "../ui/Avatar";
import { KeyboardLift } from "../ui/KeyboardLift";
import { CircleButton } from "../ui/CircleButton";
import { IconPaste, IconHelp, IconKeyboard, IconMore } from "../ui/icons";
import { DesktopClipboardMenu, DesktopInputMenu } from "./DesktopInputMenu";
import { getTrackpadMode, setTrackpadMode } from "./desktopPrefs";
import { TrackpadCapture } from "./TrackpadCapture";

const core = createCore();

/** Keysym codes the shell understands, for the keys a phone lacks. */
const KEYSYM_BACKSPACE = 0xff08;
const KEYSYM_RETURN = 0xff0d;
/** The most text one paste will type; beyond this it would run for minutes. */
const PASTE_LIMIT = 20_000;

/**
 * The key code that types one character on the computer.
 * Latin letters are their own code; a line break is Return; anything else
 * (Persian, emoji, accents outside Latin-1) is the X11 code for a Unicode
 * character. Before, those were sent as their bare character number, which is
 * a different key altogether. Returns 0 for a character with no key.
 */
function keysymOf(char: string): number {
  if (char === "\n") return KEYSYM_RETURN;
  if (char === "\t") return 0xff09;
  const point = char.codePointAt(0) ?? 0;
  if (point < 0x20) return 0;
  return point <= 0xff ? point : 0x01000000 + point;
}

/** Tries at reopening a dropped screen before giving up (about a minute in all). */
const MAX_RECONNECTS = 10;
const KEEP_AWAKE_TAG = "desktop-screen";

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
/** A computer (the web or desktop app): a real keyboard and mouse, and Ctrl+V to paste. */
const COMPUTER = process.env.EXPO_OS === "web";

export function DesktopScreen({
  accountId,
  agent,
  onApprovals,
  onError,
  embedded = false,
  control = !embedded,
  onExpand,
}: {
  /**
   * True in the panel beside a chat in the desktop window: no header and no
   * row of buttons. `onExpand` asks for the screen large, to take over.
   */
  embedded?: boolean;
  /**
   * True while the person controls the screen; false while they only watch,
   * so the agent keeps its mouse and keyboard. In the desktop window the same
   * screen switches between the two without reconnecting.
   */
  control?: boolean;
  onExpand?: () => void;
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
  const [clipOpen, setClipOpen] = useState(false);
  // A word on what a clipboard action did, shown for a moment where "Live" is.
  const [notice, setNotice] = useState<string | null>(null);
  // The latest text the computer said was selected or copied there.
  const remoteClip = useRef("");
  const [prefsReady, setPrefsReady] = useState(false);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebFrameHandle>(null);
  const inputRef = useRef<TextInput>(null);
  const trackpadRef = useRef(false);
  // Whether the person controls the screen, read when the viewer page is built.
  const controlRef = useRef(control);
  // Reconnecting: a dropped screen comes back on its own, with a fresh token.
  const [attempt, setAttempt] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const wasLive = useRef(false);
  const liveRef = useRef(false);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Opens the screen again after it dropped: a phone that slept, a network
   * switch, a core restart. Each try fetches a new token, waiting a little
   * longer each time (1s, 2s, 4s, up to 10s), and stops after a minute or so.
   */
  const reconnect = useCallback((now = false) => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (retries.current >= MAX_RECONNECTS) {
      setReconnecting(false);
      setNotice("The screen stays disconnected. Leave and open it again.");
      return;
    }
    setReconnecting(true);
    const wait = now ? 0 : Math.min(10_000, 1_000 * 2 ** retries.current);
    retries.current += 1;
    retryTimer.current = setTimeout(() => setAttempt((count) => count + 1), wait);
  }, []);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  // Back from the background with the screen gone: reconnect at once.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && wasLive.current && !liveRef.current) {
        retries.current = 0;
        reconnect(true);
      }
    });
    return () => subscription.remove();
  }, [reconnect]);

  // The phone stays awake while this screen is shown, and may sleep again on any other page.
  useFocusEffect(
    useCallback(() => {
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
      return () => {
        void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      };
    }, []),
  );

  useEffect(() => {
    let cancelled = false;
    void getTrackpadMode().then((enabled) => {
      if (!cancelled) {
        trackpadRef.current = enabled && !COMPUTER;
        setTrackpad(enabled && !COMPUTER);
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
          viewOnly: controlRef.current ? "0" : "1",
          trackpad: trackpadRef.current ? "1" : "0",
          // A browser sends its own session; the page has nothing to wait for.
          ...(process.env.EXPO_OS === "web" ? { ready: "1" } : {}),
        }).toString()}`;
        setPage(viewer);
      } catch (error) {
        if (cancelled) return;
        // While coming back, a failed token fetch (no network yet) is one more try, not an error.
        if (wasLive.current) reconnect();
        else onError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, profile, onError, prefsReady, attempt, reconnect]);

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
    if (!profile || !control) {
      return;
    }
    void core.takeOver(accountId, profile).catch(() => {});
    return () => {
      void core.handBack(accountId, profile).catch(() => {});
    };
  }, [accountId, profile, control]);

  // Watching and controlling are one screen: the viewer is told, not reloaded.
  useEffect(() => {
    if (controlRef.current === control) return;
    controlRef.current = control;
    webRef.current?.postMessage(JSON.stringify({ kind: "control", on: control }));
  }, [control]);

  function onMessage(event: WebFrameMessageEvent): void {
    let payload: { kind?: string; message?: string; text?: string };
    try {
      payload = JSON.parse(event.nativeEvent.data) as { kind?: string; message?: string; text?: string };
    } catch {
      return;
    }
    if (payload.kind === "clipboard") {
      if (typeof payload.text === "string") remoteClip.current = payload.text;
    } else if (payload.kind === "connect") {
      setLive(true);
      liveRef.current = true;
      wasLive.current = true;
      retries.current = 0;
      setReconnecting(false);
      applyTrackpad(trackpadRef.current);
    } else if (payload.kind === "disconnect") {
      setLive(false);
      liveRef.current = false;
      reconnect();
    } else if (payload.kind === "error" || payload.kind === "auth") {
      setLive(false);
      liveRef.current = false;
      if (wasLive.current) {
        // It worked before, so this is a failed try at coming back (the viewer
        // reports any first failure as "auth"): try again.
        reconnect();
      } else if (payload.kind === "error") {
        onError(new Error(payload.message ?? "The desktop connection failed."));
      } else {
        // The viewer reached the core but the socket was refused, which means the
        // page loaded without a usable session cookie. Say so instead of sitting
        // on "Connecting" forever.
        onError(new Error("Sign in again to watch this screen."));
      }
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
        const keysym = keysymOf(char);
        if (keysym) sendKey(keysym);
      }
    }
    setTyped(next);
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Phone to computer: types what is on the phone's clipboard where the
   * computer's cursor is, and puts it on the computer's clipboard too.
   * Why typed: a phone keyboard has no Ctrl+V to paste with, and typing works
   * in every program, a terminal included, in any language.
   */
  async function pasteFromPhone(): Promise<void> {
    const text = (await Clipboard.getStringAsync().catch(() => "")).slice(0, PASTE_LIMIT);
    if (!text) {
      setNotice("Nothing is copied on the phone");
      return;
    }
    const keysyms = Array.from(text.replace(/\r\n?/g, "\n"), keysymOf).filter((keysym) => keysym > 0);
    // Sent a few dozen keys at a time, so a long paste does not flood the connection.
    webRef.current?.injectJavaScript(`(function(){
      var rfb = window.nanoRfb; if (!rfb) return;
      try { rfb.clipboardPasteFrom(${JSON.stringify(text)}); } catch (e) {}
      var keys = ${JSON.stringify(keysyms)}; var at = 0;
      (function step(){
        var end = Math.min(at + 40, keys.length);
        for (; at < end; at++) rfb.sendKey(keys[at], "");
        if (at < keys.length) setTimeout(step, 30);
      })();
    })(); true;`);
    setNotice(keysyms.length > 400 ? "Typing it on the computer…" : "Pasted on the computer");
  }

  /** Computer to phone: what was last selected or copied there goes on the phone's clipboard. */
  async function copyToPhone(): Promise<void> {
    const text = remoteClip.current;
    if (!text) {
      setNotice("Select or copy text on the computer first");
      return;
    }
    await Clipboard.setStringAsync(text);
    setNotice("Copied to the phone");
  }

  function toggleTrackpad(): void {
    const next = !trackpadRef.current;
    trackpadRef.current = next;
    setTrackpad(next);
    applyTrackpad(next);
    void setTrackpadMode(next).catch(() => {});
  }

  useLayoutEffect(() => {
    if (embedded) return;
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
  }, [agent, navigation, trackpad, embedded]);

  return (
    // The remote screen and the buttons under it stay above the keyboard.
    <KeyboardLift style={styles.screen} absorb={Math.max(18, insets.bottom) - 18}>
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
          <WebFrame
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
            onError={() => (wasLive.current ? reconnect() : onError(new Error("The desktop viewer failed to load.")))}
            // The system can kill the page behind the screen; bring it back.
            onContentProcessDidTerminate={() => reconnect(true)}
            onRenderProcessGone={() => reconnect(true)}
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
        <Text style={[styles.status, live ? styles.live : null]} pointerEvents="none" accessibilityLiveRegion="polite">
          {notice ?? (profile ? (live ? "Live" : reconnecting ? "Reconnecting…" : "Connecting") : "No desktop")}
        </Text>
        {!control && onExpand && page ? (
          // Watching only. A click anywhere opens the full screen, where the person takes over.
          <Pressable style={StyleSheet.absoluteFill} onPress={onExpand} accessibilityRole="button" accessibilityLabel="Open the screen and take control" />
        ) : null}
      </View>
      {/* A computer types and pastes with its own keyboard, so the Keyboard and Clipboard buttons are a phone thing. */}
      {embedded || COMPUTER ? null : (
        <>
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
      {clipOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close clipboard menu"
          onPress={() => setClipOpen(false)}
          style={styles.menuScrim}
        />
      ) : null}
      {clipOpen ? (
        // Its own layer, a fixed distance above the row of buttons (18 + 44 +
        // the bottom padding), so it can never sit behind them.
        <View style={[styles.clipCard, { bottom: 62 + Math.max(18, insets.bottom) + 8 }]} pointerEvents="box-none">
          <DesktopClipboardMenu
            onToComputer={() => void pasteFromPhone()}
            onToPhone={() => void copyToPhone()}
            onClose={() => setClipOpen(false)}
          />
        </View>
      ) : null}
      <View style={[styles.footer, clipOpen ? styles.footerRaised : null, { paddingBottom: Math.max(18, insets.bottom) }]}>
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
        <CircleButton label="Clipboard" active={clipOpen} onPress={() => setClipOpen((open) => !open)} disabled={!live}>
          <IconPaste />
        </CircleButton>
      </View>
        </>
      )}
    </KeyboardLift>
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
  footer: { flexDirection: "row", justifyContent: "center", gap: 16, paddingHorizontal: 16, paddingVertical: 18 },
  // Above the scrim that closes the clipboard menu, so the menu and buttons still take taps.
  footerRaised: { zIndex: 3 },
  clipCard: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 4, elevation: 20 },
  menuCard: { position: "absolute", top: 8, right: 8, zIndex: 3 },
  menuScrim: { ...StyleSheet.absoluteFill, zIndex: 2 },
});
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
