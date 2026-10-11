import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MessageBlock } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconCloseLight, IconDownload, IconDownloadLight, IconFullscreen, IconPlay } from "../ui/icons";

export type FetchBlob = (
  messageId: string,
  index: number,
) => Promise<{ url?: string; previewUrl?: string; headers?: Record<string, string> }>;
export type ImageBlock = Extract<MessageBlock, { kind: "image" }>;
export type FileBlock = Extract<MessageBlock, { kind: "file" }>;

// Client-side bytes cache: one fetch per attachment no matter how often the
// thread re-renders or refreshes. Keyed messageId:index, process-lifetime.
const blobCache = new Map<string, { url?: string; previewUrl?: string }>();

/**
 * Resolves the picture for one image block, fetching stripped bytes on demand.
 * Why: lists carry a blobRef instead of the bytes, so the thread stays at
 * kilobytes. `full` asks for the original (the viewer); bubbles take the
 * small preview when there is one.
 * Input: block, fetcher, full flag. Output: a URI, or null while it loads.
 */
function useImageUri(block: ImageBlock, fetchBlob: FetchBlob | undefined, full = false): string | null {
  const inline = full ? block.url || block.previewUrl : block.previewUrl || block.url;
  const cacheKey = block.blobRef ? `${block.blobRef.messageId}:${block.blobRef.index}` : null;
  const [blob, setBlob] = useState(cacheKey ? (blobCache.get(cacheKey) ?? null) : null);
  const messageId = block.blobRef?.messageId;
  const index = block.blobRef?.index;
  useEffect(() => {
    if (inline || !cacheKey || !fetchBlob || messageId === undefined || index === undefined) return;
    const cached = blobCache.get(cacheKey);
    if (cached) {
      setBlob(cached);
      return;
    }
    let live = true;
    void fetchBlob(messageId, index)
      .then((next) => {
        blobCache.set(cacheKey, next);
        if (live) setBlob(next);
      })
      .catch(() => {
        // Offline or gone: placeholder stays, refresh retries via remount.
      });
    return () => {
      live = false;
    };
  }, [inline, cacheKey, messageId, index, fetchBlob]);
  if (inline) return inline;
  if (!blob) return null;
  return (full ? blob.url || blob.previewUrl : blob.previewUrl || blob.url) ?? null;
}

/** The original picture as a file block, so it can go to the share sheet. */
async function imageAsFile(block: ImageBlock, fetchBlob: FetchBlob | undefined, position: number): Promise<FileBlock | null> {
  let url = block.url;
  if (!url && block.blobRef) {
    const key = `${block.blobRef.messageId}:${block.blobRef.index}`;
    const blob = blobCache.get(key) ?? (fetchBlob ? await fetchBlob(block.blobRef.messageId, block.blobRef.index) : null);
    if (blob) blobCache.set(key, blob);
    url = blob?.url ?? blob?.previewUrl ?? "";
  }
  url = url || block.previewUrl || "";
  if (!url) return null;
  const mime = /^data:(image\/[a-z0-9.+-]+)/i.exec(url)?.[1];
  const extension = mime ? mime.split("/")[1]!.replace("jpeg", "jpg").replace("svg+xml", "svg") : (/\.(png|jpe?g|gif|webp|heic)([?#]|$)/i.exec(url)?.[1] ?? "jpg");
  const named = block.alt && /\.[a-z0-9]{2,5}$/i.test(block.alt) ? block.alt : `image-${position + 1}.${extension}`;
  return { kind: "file", name: named, url, mime };
}

const ALBUM_WIDTH = 240;
const ALBUM_GAP = 2;
const ALBUM_MAX_TILES = 4;

type Tile = { left: number; top: number; width: number; height: number };

/**
 * Lays several pictures out as one mosaic, Telegram-album style.
 * Input: how many pictures. Output: the album height and one box per tile
 * (at most four; the caller draws "+N" on the last when there are more).
 */
export function albumLayout(count: number): { height: number; tiles: Tile[] } {
  const half = (ALBUM_WIDTH - ALBUM_GAP) / 2;
  if (count === 2) {
    return {
      height: 160,
      tiles: [
        { left: 0, top: 0, width: half, height: 160 },
        { left: half + ALBUM_GAP, top: 0, width: half, height: 160 },
      ],
    };
  }
  if (count === 3) {
    const wide = 158;
    const narrow = ALBUM_WIDTH - wide - ALBUM_GAP;
    const small = (200 - ALBUM_GAP) / 2;
    return {
      height: 200,
      tiles: [
        { left: 0, top: 0, width: wide, height: 200 },
        { left: wide + ALBUM_GAP, top: 0, width: narrow, height: small },
        { left: wide + ALBUM_GAP, top: small + ALBUM_GAP, width: narrow, height: small },
      ],
    };
  }
  return {
    height: ALBUM_WIDTH,
    tiles: [0, 1, 2, 3].map((slot) => ({
      left: (slot % 2) * (half + ALBUM_GAP),
      top: Math.floor(slot / 2) * (half + ALBUM_GAP),
      width: half,
      height: half,
    })),
  };
}

function ImageTile({
  block,
  fetchBlob,
  more,
  onPress,
}: {
  block: ImageBlock;
  fetchBlob?: FetchBlob;
  /** Pictures hidden behind this tile, drawn as "+N". */
  more?: number;
  onPress: () => void;
}) {
  const uri = useImageUri(block, fetchBlob);
  return (
    <Pressable
      style={styles.fill}
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={block.alt ?? "Shared image"}
    >
      {uri ? <Image source={{ uri }} style={styles.fill} contentFit="cover" transition={120} /> : <View style={styles.loading} />}
      {more ? (
        <View style={styles.moreVeil}>
          <Text style={styles.moreText}>+{more}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Renders the pictures of one message: a single photo, or an album mosaic.
 * Why: several screenshots in a row used to stack as full-size photos and push
 * the thread away. Tapping any picture opens the full-screen viewer.
 * Input: the image blocks that sit together + blob fetcher. Output: the view.
 */
export function ImageGroup({ images, fetchBlob }: { images: ImageBlock[]; fetchBlob?: FetchBlob }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const viewer =
    viewing !== null ? (
      <ImageViewer images={images} start={viewing} fetchBlob={fetchBlob} onClose={() => setViewing(null)} />
    ) : null;
  const first = images[0];
  if (!first) return null;
  if (images.length === 1) {
    return (
      <View style={styles.mediaWrap}>
        <View style={styles.single}>
          <ImageTile block={first} fetchBlob={fetchBlob} onPress={() => setViewing(0)} />
        </View>
        {first.alt ? <Text style={styles.caption}>{first.alt}</Text> : null}
        {viewer}
      </View>
    );
  }
  const { height, tiles } = albumLayout(images.length);
  const hidden = images.length - ALBUM_MAX_TILES;
  return (
    <View style={[styles.album, { height }]}>
      {tiles.map((tile, slot) => {
        const block = images[slot];
        if (!block) return null;
        return (
          <View key={slot} style={[styles.tile, tile]}>
            <ImageTile
              block={block}
              fetchBlob={fetchBlob}
              more={slot === ALBUM_MAX_TILES - 1 && hidden > 0 ? hidden : undefined}
              onPress={() => setViewing(slot)}
            />
          </View>
        );
      })}
      {viewer}
    </View>
  );
}

function ViewerPage({
  block,
  fetchBlob,
  width,
  height,
}: {
  block: ImageBlock;
  fetchBlob?: FetchBlob;
  width: number;
  height: number;
}) {
  const uri = useImageUri(block, fetchBlob, true);
  return (
    // A zooming ScrollView per page gives native pinch and double-tap-drag.
    <ScrollView
      style={{ width, height }}
      contentContainerStyle={{ width, height }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      bouncesZoom
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {uri ? (
        <Image source={{ uri }} style={{ width, height }} contentFit="contain" accessibilityLabel={block.alt ?? "Shared image"} />
      ) : (
        <View style={[styles.viewerLoading, { width, height }]}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      )}
    </ScrollView>
  );
}

/** Full-screen pager over one message's pictures: swipe between, pinch to zoom. */
function ImageViewer({
  images,
  start,
  fetchBlob,
  onClose,
}: {
  images: ImageBlock[];
  start: number;
  fetchBlob?: FetchBlob;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(start);
  const [saving, setSaving] = useState(false);
  const caption = images[index]?.alt;
  const save = (): void => {
    const block = images[index];
    if (!block || saving) return;
    setSaving(true);
    void imageAsFile(block, fetchBlob, index)
      .then((file) => (file ? shareFileBlock(file) : undefined))
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer}>
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={start}
          getItemLayout={(_data, item) => ({ length: width, offset: width * item, index: item })}
          keyExtractor={(_block, item) => String(item)}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => <ViewerPage block={item} fetchBlob={fetchBlob} width={width} height={height} />}
        />
        <View style={[styles.viewerBar, { top: insets.top + 8 }]} pointerEvents="box-none">
          <Pressable style={styles.viewerButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <IconCloseLight />
          </Pressable>
          {images.length > 1 ? (
            <Text style={styles.viewerCount}>
              {index + 1} / {images.length}
            </Text>
          ) : null}
          <Pressable style={styles.viewerButton} onPress={save} accessibilityRole="button" accessibilityLabel="Save image">
            {saving ? <ActivityIndicator color="#FFFFFF" size="small" /> : <IconDownloadLight />}
          </Pressable>
        </View>
        {caption ? (
          <Text style={[styles.viewerCaption, { bottom: insets.bottom + 16 }]} numberOfLines={3}>
            {caption}
          </Text>
        ) : null}
      </View>
    </Modal>
  );
}

const VIDEO_NAME = /\.(mp4|m4v|mov)([?#]|$)/i;
const VIDEO_MIME: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v" };

/** True for file blocks the system player can play in place. */
export function isVideoBlock(block: FileBlock): boolean {
  if ((block.mime ?? "").toLowerCase() in VIDEO_MIME) return true;
  return VIDEO_NAME.test(block.name) || (/^https?:\/\//i.test(block.url) && VIDEO_NAME.test(block.url));
}

/**
 * Turns a file block into something the device can open: a web URL as it is,
 * or inline/lazy bytes written to the cache folder.
 * Input: block, fetcher, and `keep` to give the file its own name and reuse it
 * (playback); without it the plain name is rewritten each time (share sheet).
 * `download` also pulls a web URL down, for the share sheet and Save.
 * Output: a URL or file URI plus the mime type found, or null with no bytes.
 */
async function materializeFile(
  block: FileBlock,
  fetchBlob: FetchBlob | undefined,
  keep = false,
  download = false,
): Promise<{ uri: string; mime?: string; local: boolean; headers?: Record<string, string> } | null> {
  let url = block.url;
  let headers: Record<string, string> | undefined;
  if (!url && block.blobRef && fetchBlob) {
    const found = await fetchBlob(block.blobRef.messageId, block.blobRef.index);
    url = found.url ?? "";
    headers = found.headers;
  }
  if (!url) return null;
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  // A file streamed from the agent's computer needs the session to fetch, so
  // only the player (`keep`) uses its address; everything else gets a copy.
  if (!data && (download || (headers && !keep)) && /^https?:\/\//i.test(url)) {
    const target = new File(Paths.cache, block.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "attachment");
    if (target.exists) target.delete();
    const saved = await File.downloadFileAsync(url, target, headers ? { headers } : undefined);
    return { uri: saved.uri, mime: block.mime, local: true };
  }
  if (!data) return { uri: url, mime: block.mime, local: false, headers };
  const mime = block.mime ?? data[1];
  let name = block.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "attachment";
  // The player picks its decoder from the extension, so a bare name gets one.
  const extension = VIDEO_MIME[(mime ?? "").toLowerCase()];
  if (keep && extension && !VIDEO_NAME.test(name)) name = `${name}${extension}`;
  if (keep && block.blobRef) name = `${block.blobRef.messageId.slice(0, 8)}-${block.blobRef.index}-${name}`;
  const file = new File(Paths.cache, name);
  if (keep && file.exists) return { uri: file.uri, mime, local: true };
  const raw = globalThis.atob(data[2]!);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return { uri: file.uri, mime, local: true };
}

/** Resolves lazy bytes, writes them to device cache, then opens the native share/preview sheet. */
export async function openFileBlock(block: FileBlock, fetchBlob?: FetchBlob): Promise<void> {
  const file = await materializeFile(block, fetchBlob);
  if (!file) return;
  if (file.local && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(file.uri, { mimeType: file.mime, dialogTitle: `Open ${block.name}` });
  } else {
    await Linking.openURL(file.uri);
  }
}

/** Hands a file to the system share sheet (Save Image/Video, Save to Files, other apps). */
export async function shareFileBlock(block: FileBlock, fetchBlob?: FetchBlob): Promise<void> {
  const file = await materializeFile(block, fetchBlob, false, true);
  if (!file) return;
  if (file.local && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(file.uri, { mimeType: file.mime, dialogTitle: block.name });
  } else {
    await Linking.openURL(file.uri);
  }
}

/**
 * Saves a file where the person chooses (Files on iOS, a folder on Android).
 * Output: true when written, false when they closed the picker.
 */
export async function saveFileBlock(block: FileBlock, fetchBlob?: FetchBlob): Promise<boolean> {
  const file = await materializeFile(block, fetchBlob, false, true);
  if (!file || !file.local) throw new Error("Nothing to save.");
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch {
    return false;
  }
  const source = new File(file.uri);
  const target = new File(folder, source.name);
  if (target.exists) target.delete();
  source.copy(target);
  return true;
}

/** Reads a file block as text, for the in-app viewer. */
export async function readFileText(block: FileBlock, fetchBlob?: FetchBlob): Promise<string> {
  let url = block.url;
  let headers: Record<string, string> | undefined;
  if (!url && block.blobRef && fetchBlob) {
    const found = await fetchBlob(block.blobRef.messageId, block.blobRef.index);
    url = found.url ?? "";
    headers = found.headers;
  }
  if (!url) throw new Error("This file has no content.");
  const base64 = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (base64) {
    const raw = globalThis.atob(base64[1]!);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }
  if (url.startsWith("data:")) return decodeURIComponent(url.slice(url.indexOf(",") + 1));
  const response = await fetch(url, headers ? { headers, credentials: "omit" } : undefined);
  if (!response.ok) throw new Error(`The file did not load (${response.status}).`);
  return response.text();
}

function InlineVideo({ uri, headers, fullScreen }: { uri: string; headers?: Record<string, string>; fullScreen: number }) {
  const view = useRef<VideoView>(null);
  // Each press of the full-screen button bumps the count; the short wait lets a
  // just-mounted player attach before it is asked to go full screen.
  useEffect(() => {
    if (fullScreen === 0) return;
    const timer = setTimeout(() => void view.current?.enterFullscreen().catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, [fullScreen]);
  // With headers the player streams from the core and asks for the parts it needs.
  const player = useVideoPlayer(headers ? { uri, headers } : uri, (created) => {
    created.play();
  });
  return (
    <VideoView
      ref={view}
      player={player}
      style={styles.video}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      allowsPictureInPicture={false}
    />
  );
}

/**
 * Plays a video the agent sent, in the bubble, with the system player.
 * Why: a video used to be a "Tap to open" file row that left the chat. The
 * poster costs nothing; the bytes load and the player starts on the first tap,
 * so a thread full of videos does not hold a decoder each.
 * Input: a video file block + blob fetcher. Output: poster, then the player.
 */
export function VideoBlock({ block, fetchBlob }: { block: FileBlock; fetchBlob?: FetchBlob }) {
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const uri = source?.uri ?? null;
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullScreen, setFullScreen] = useState(0);

  function start(): void {
    if (busy || uri) return;
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
    <View style={styles.mediaWrap}>
      {uri ? (
        <InlineVideo uri={uri} headers={source?.headers} fullScreen={fullScreen} />
      ) : (
        <Pressable style={styles.poster} onPress={start} accessibilityRole="button" accessibilityLabel={`Play ${block.name}`}>
          <View style={styles.playDisk}>{busy ? <ActivityIndicator color="#FFFFFF" /> : <IconPlay />}</View>
        </Pressable>
      )}
      <View style={styles.videoBar}>
        <Text style={[styles.caption, styles.videoName]} numberOfLines={1}>
          {failed ? "Could not load this video. Tap to retry." : block.name}
        </Text>
        <Pressable
          style={styles.videoAction}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Full screen"
          onPress={() => {
            start();
            setFullScreen((count) => count + 1);
          }}
        >
          <IconFullscreen />
        </Pressable>
        <Pressable style={styles.videoAction} hitSlop={6} accessibilityRole="button" accessibilityLabel="Save video" onPress={save}>
          {saving ? <ActivityIndicator color={colors.text} size="small" /> : <IconDownload />}
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    mediaWrap: { gap: 6 },
    fill: { flex: 1 },
    single: { width: ALBUM_WIDTH, height: 180, borderRadius: 12, overflow: "hidden", backgroundColor: colors.control },
    loading: { flex: 1, backgroundColor: colors.control, opacity: 0.6 },
    caption: { color: colors.muted, fontSize: 13, maxWidth: ALBUM_WIDTH },
    album: { width: ALBUM_WIDTH, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" },
    tile: { position: "absolute", backgroundColor: colors.control },
    moreVeil: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
    },
    moreText: { color: "#FFFFFF", fontSize: 22, fontWeight: "600" },
    viewer: { flex: 1, backgroundColor: "#000000" },
    viewerLoading: { alignItems: "center", justifyContent: "center" },
    viewerBar: {
      position: "absolute",
      left: 12,
      right: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    viewerButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: "rgba(60,60,60,0.7)",
      alignItems: "center",
      justifyContent: "center",
    },
    viewerCount: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
    viewerCaption: {
      position: "absolute",
      left: 20,
      right: 20,
      color: "#FFFFFF",
      fontSize: 14,
      textAlign: "center",
    },
    videoBar: { flexDirection: "row", alignItems: "center", gap: 6, width: ALBUM_WIDTH },
    videoName: { flex: 1 },
    videoAction: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.control,
      alignItems: "center",
      justifyContent: "center",
    },
    video: { width: ALBUM_WIDTH, height: 150, borderRadius: 12, overflow: "hidden", backgroundColor: "#000000" },
    poster: {
      width: ALBUM_WIDTH,
      height: 150,
      borderRadius: 12,
      backgroundColor: "#000000",
      alignItems: "center",
      justifyContent: "center",
    },
    playDisk: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: "rgba(60,60,60,0.8)",
      alignItems: "center",
      justifyContent: "center",
    },
  });
}

let styles = createStyles(darkColors);
onPaletteChange((next) => {
  styles = createStyles(next);
});
