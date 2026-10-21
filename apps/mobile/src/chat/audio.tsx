import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useEventListener } from "expo";
import { useVideoPlayer } from "expo-video";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconDownload, IconPauseSmall, IconPlaySmall } from "../ui/icons";
import { innerTouching } from "./MarkdownText";
import { materializeFile, shareFileBlock, type FetchBlob, type FileBlock } from "./media";

const WIDTH = 240;
const TRACK_WIDTH = WIDTH - 40 - 10 - 24;

/** Seconds as m:ss, or h:mm:ss past an hour. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const s = String(whole % 60).padStart(2, "0");
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The part of the player that exists only once the sound is loaded.
 * It uses the video library's player with no picture: that library already
 * ships in the app and plays wav, mp3, m4a and the rest through the system.
 * Input: where the sound is and the headers to fetch it with.
 * Output: play/pause, a bar that can be tapped or dragged to seek, and the time.
 */
/**
 * Sound in a browser: the browser's own player. The phone's player plays only
 * through a video on screen in a browser, so sound alone stayed silent there.
 */
function BrowserAudio({ uri }: { uri: string }) {
  return <audio src={uri} controls autoPlay style={{ flex: 1, height: 40 }} />;
}

function Playing({ uri, headers }: { uri: string; headers?: Record<string, string> }) {
  const player = useVideoPlayer(headers ? { uri, headers } : uri, (created) => {
    created.timeUpdateEventInterval = 0.2;
    created.play();
  });
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  // How far through, 0 to 1. Drawn on the UI thread so the bar follows a drag exactly.
  const progress = useSharedValue(0);
  const scrubbing = useSharedValue(false);

  useEventListener(player, "playingChange", ({ isPlaying }) => setPlaying(isPlaying));
  useEventListener(player, "sourceLoad", ({ duration }) => setLength(duration));
  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    setTime(currentTime);
    const total = length || player.duration;
    if (total > 0 && !scrubbing.value) progress.value = Math.min(1, currentTime / total);
  });
  useEventListener(player, "playToEnd", () => {
    // Back to the start, ready to play again.
    player.pause();
    player.currentTime = 0;
    progress.value = 0;
    setTime(0);
  });

  const seek = (fraction: number): void => {
    const total = length || player.duration;
    if (total > 0) {
      player.currentTime = fraction * total;
      setTime(fraction * total);
    }
  };

  // One gesture for a tap and a drag on the bar. While it holds the touch the
  // bubble's swipe-to-reply stands down, so scrubbing right never replies.
  const scrub = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .hitSlop({ top: 12, bottom: 12, left: 6, right: 6 })
        .onBegin((event) => {
          scrubbing.value = true;
          innerTouching.value = true;
          progress.value = Math.min(1, Math.max(0, event.x / TRACK_WIDTH));
        })
        .onUpdate((event) => {
          progress.value = Math.min(1, Math.max(0, event.x / TRACK_WIDTH));
        })
        .onFinalize(() => {
          scheduleOnRN(seek, progress.value);
          scrubbing.value = false;
          innerTouching.value = false;
        }),
    // Rebuilt when the length arrives, which is the only thing `seek` depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [length],
  );

  const fill = useAnimatedStyle(() => ({ width: progress.value * TRACK_WIDTH }));
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * TRACK_WIDTH - 6 }] }));

  return (
    <>
      <Pressable
        style={styles.disk}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause" : "Play"}
        onPress={() => (playing ? player.pause() : player.play())}
      >
        {playing ? <IconPauseSmall /> : <IconPlaySmall />}
      </Pressable>
      <View style={styles.middle}>
        <GestureDetector gesture={scrub}>
          <View style={styles.trackHit} accessibilityRole="adjustable" accessibilityLabel="Position">
            <View style={styles.track}>
              <Animated.View style={[styles.fill, fill]} />
            </View>
            <Animated.View style={[styles.knob, knob]} />
          </View>
        </GestureDetector>
        <Text style={styles.time}>
          {clock(time)}
          {length > 0 ? ` / ${clock(length)}` : ""}
        </Text>
      </View>
    </>
  );
}

/**
 * Plays a sound file the agent sent, in the bubble.
 * Why: a .wav used to be a "Tap to open" row that only offered the share
 * sheet, so there was no way to simply listen to it. Nothing loads until
 * Play is pressed, so a thread full of recordings costs nothing.
 * Input: an audio file block + blob fetcher. Output: the player row.
 */
export function AudioBlock({ block, fetchBlob }: { block: FileBlock; fetchBlob?: FetchBlob }) {
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  function start(): void {
    if (busy || source) return;
    setBusy(true);
    setFailed(false);
    void materializeFile(block, fetchBlob, true)
      .then((file) => {
        if (file) setSource({ uri: file.uri, headers: file.headers });
        else setFailed(true);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }

  function save(): void {
    if (saving) return;
    setSaving(true);
    void shareFileBlock(block, fetchBlob)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  }

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        {source ? (
          process.env.EXPO_OS === "web" ? (
            <BrowserAudio uri={source.uri} />
          ) : (
            <Playing uri={source.uri} headers={source.headers} />
          )
        ) : (
          <>
            <Pressable style={styles.disk} hitSlop={6} onPress={start} accessibilityRole="button" accessibilityLabel={`Play ${block.name}`}>
              {busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <IconPlaySmall />}
            </Pressable>
            <View style={styles.middle}>
              <View style={styles.trackHit}>
                <View style={styles.track} />
              </View>
              <Text style={styles.time}>{failed ? "Could not load. Tap play to retry." : "Audio"}</Text>
            </View>
          </>
        )}
        <Pressable style={styles.save} hitSlop={8} accessibilityRole="button" accessibilityLabel="Save audio" onPress={save}>
          {saving ? <ActivityIndicator color={colors.text} size="small" /> : <IconDownload />}
        </Pressable>
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {block.name}
      </Text>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    card: {
      width: WIDTH + 24,
      backgroundColor: colors.bubble,
      borderRadius: 18,
      borderCurve: "continuous",
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 8,
      gap: 4,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    disk: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.online,
      alignItems: "center",
      justifyContent: "center",
    },
    middle: { width: TRACK_WIDTH, gap: 2 },
    trackHit: { height: 20, justifyContent: "center" },
    track: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" },
    fill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: colors.online },
    knob: { position: "absolute", left: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: colors.online },
    time: { color: colors.muted, fontSize: 12, fontVariant: ["tabular-nums"] },
    save: { width: 24, height: 40, alignItems: "center", justifyContent: "center" },
    name: { color: colors.muted, fontSize: 12 },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
