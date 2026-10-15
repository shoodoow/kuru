import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Linking, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useEventListener } from "expo";
import { Image } from "expo-image";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  type SharedValue,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import type { MessageBlock } from "../api";
import { colors, darkColors, onPaletteChange, type ColorPalette } from "../theme/tokens";
import { IconCloseLight, IconDownload, IconDownloadLight, IconPlay } from "../ui/icons";
import { presentOverlay } from "../ui/overlay";
import { innerTouching } from "./MarkdownText";

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

/** A lone picture keeps its own shape, within these bounds, instead of being cropped to a fixed box. */
const SINGLE_MIN_HEIGHT = 120;
const SINGLE_MAX_HEIGHT = 320;

function ImageTile({
  block,
  fetchBlob,
  more,
  onPress,
  onSize,
}: {
  block: ImageBlock;
  fetchBlob?: FetchBlob;
  /** Pictures hidden behind this tile, drawn as "+N". */
  more?: number;
  onPress: () => void;
  /** Told the picture's real size once it has loaded. */
  onSize?: (width: number, height: number) => void;
}) {
  const uri = useImageUri(block, fetchBlob);
  return (
    <Pressable
      style={({ pressed }) => [styles.fill, pressed ? styles.tilePressed : null]}
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={block.alt ?? "Shared image"}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={styles.fill}
          contentFit="cover"
          transition={120}
          onLoad={onSize ? (event) => onSize(event.source.width, event.source.height) : undefined}
        />
      ) : (
        <View style={styles.loading} />
      )}
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
  // The viewer is drawn from the top of the app, not from inside this bubble: see presentOverlay.
  const view = (start: number): void =>
    presentOverlay((close) => <ImageViewer images={images} start={start} fetchBlob={fetchBlob} onClose={close} />);
  const [singleHeight, setSingleHeight] = useState(180);
  const first = images[0];
  if (!first) return null;
  if (images.length === 1) {
    return (
      <View style={styles.mediaWrap}>
        <View style={[styles.single, { height: singleHeight }]}>
          <ImageTile
            block={first}
            fetchBlob={fetchBlob}
            onPress={() => view(0)}
            onSize={(width, height) => {
              if (width > 0 && height > 0) {
                setSingleHeight(Math.round(Math.min(SINGLE_MAX_HEIGHT, Math.max(SINGLE_MIN_HEIGHT, (ALBUM_WIDTH * height) / width))));
              }
            }}
          />
        </View>
        {first.alt ? <Text style={styles.caption}>{first.alt}</Text> : null}
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
              onPress={() => view(slot)}
            />
          </View>
        );
      })}
    </View>
  );
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)([?#]|$)/i;

/** True for a file that is a picture, so it can be shown instead of offered to other apps. */
export function isImageFile(block: FileBlock): boolean {
  const mime = (block.mime ?? "").toLowerCase();
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return true;
  return IMAGE_NAME.test(block.name) || (/^https?:\/\//i.test(block.url) && IMAGE_NAME.test(block.url));
}

/**
 * Finds something the picture view can load for a picture sent as a file.
 * A web address is used as it is. Bytes held in the message, and a picture
 * that has to be fetched with the session from the agent's computer, are
 * written to the cache folder once, under a name of their own.
 * Output: a URI, or null when the file has no content.
 */
async function imageFileUri(block: FileBlock, fetchBlob: FetchBlob | undefined): Promise<string | null> {
  const file = await materializeFile(block, fetchBlob, true);
  if (!file) return null;
  if (!file.headers) return file.uri;
  const prefix = block.blobRef ? `${block.blobRef.messageId.slice(0, 8)}-${block.blobRef.index}-` : "";
  const target = new File(Paths.cache, `${prefix}${block.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "image"}`);
  if (target.exists) return target.uri;
  const saved = await File.downloadFileAsync(file.uri, target, { headers: file.headers });
  return saved.uri;
}

/**
 * Shows a picture that an agent sent as a file.
 * Why: agents often attach a screenshot or a chart as a plain file. That used
 * to be a "Tap to open" row that only handed the picture to other apps. It is
 * now drawn in the chat like any other picture, with the same viewer.
 * Input: the file block, the blob fetcher, and what to show if the picture
 * cannot be loaded (the ordinary file row). Output: the picture.
 */
export function ImageFileBlock({ block, fetchBlob, fallback }: { block: FileBlock; fetchBlob?: FetchBlob; fallback: ReactNode }) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void imageFileUri(block, fetchBlob)
      .then((found) => {
        if (!live) return;
        if (found) setUri(found);
        else setFailed(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [block, fetchBlob]);
  const image = useMemo<ImageBlock[]>(() => (uri ? [{ kind: "image", url: uri, alt: block.name }] : []), [uri, block.name]);
  if (failed) return <>{fallback}</>;
  if (!uri) {
    return (
      <View style={[styles.single, styles.singleLoading]}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }
  return <ImageGroup images={image} />;
}

/**
 * One square in a media grid: a picture, or a video shown with a play mark.
 * Why: the profile's Media tab listed names only, and pictures sent as files
 * were filed under Files. It is a grid of what was shared, like a phone's
 * photo library; a tap opens the item.
 * Input: the picture or video (a web address, or a file block to load the way
 * the chat does), the blob fetcher, and the square's size.
 */
export function MediaThumb({
  url,
  file,
  video,
  fetchBlob,
  size,
}: {
  url: string;
  file?: FileBlock;
  video?: boolean;
  fetchBlob?: FetchBlob;
  size: number;
}) {
  const [uri, setUri] = useState<string | null>(file || video ? null : url);
  useEffect(() => {
    if (!file || video) return;
    let live = true;
    void imageFileUri(file, fetchBlob)
      .then((found) => {
        if (live && found) setUri(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [file, video, fetchBlob]);
  const open = (): void => {
    if (file) void openFileBlock(file, fetchBlob);
    else void Linking.openURL(url);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={video ? `Video ${file?.name ?? ""}` : `Picture ${file?.name ?? ""}`}
      onPress={open}
      style={({ pressed }) => [styles.thumb, { width: size, height: size }, pressed ? { opacity: 0.7 } : null]}
    >
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} /> : null}
      {video ? (
        <View style={styles.thumbPlay}>
          <IconPlay />
        </View>
      ) : !uri ? (
        <ActivityIndicator color={colors.muted} />
      ) : null}
    </Pressable>
  );
}

const ZOOM_MAX = 4;
const ZOOM_DOUBLE_TAP = 2.5;
/** How far, or how fast, a picture must be dragged down or up to close the viewer. */
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 900;
const SETTLE = { duration: 350, dampingRatio: 1 } as const;

/**
 * One picture in the viewer, with the gestures a photo app has.
 * Pinch zooms around the fingers, a drag moves a zoomed picture, a double tap
 * zooms in on the spot tapped and back out, one tap shows or hides the
 * buttons, and at normal size a drag down or up puts the picture away.
 * Why hand-built: the scroll view's own zoom only exists on iOS, so Android
 * had no zoom at all. All of it runs on the UI thread.
 * Input: the picture, the page size, `pull` (how far the picture is being
 * dragged away, shared with the backdrop), and what a tap, a zoom and a
 * dismissal do. Output: the page.
 */
function ViewerPage({
  block,
  fetchBlob,
  width,
  height,
  pull,
  onTap,
  onZoom,
  onDismiss,
}: {
  block: ImageBlock;
  fetchBlob?: FetchBlob;
  width: number;
  height: number;
  pull: SharedValue<number>;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
  onDismiss: () => void;
}) {
  const uri = useImageUri(block, fetchBlob, true);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Where things stood when the gesture in progress began.
  const fromScale = useSharedValue(1);
  const fromX = useSharedValue(0);
  const fromY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const downX = useSharedValue(0);
  const downY = useSharedValue(0);
  const slipX = useSharedValue(0);
  const slipY = useSharedValue(0);
  const dragging = useSharedValue(false);

  const gesture = useMemo(() => {
    // Furthest the picture may sit from the middle at a given zoom, so an edge never leaves the screen.
    const limit = (size: number, zoom: number): number => {
      "worklet";
      return Math.max(0, (size * zoom - size) / 2);
    };
    const clamp = (value: number, bound: number): number => {
      "worklet";
      return Math.min(bound, Math.max(-bound, value));
    };
    const settle = (): void => {
      "worklet";
      const zoom = Math.min(ZOOM_MAX, Math.max(1, scale.get()));
      scale.set(withSpring(zoom, SETTLE));
      x.set(withSpring(zoom === 1 ? 0 : clamp(x.get(), limit(width, zoom)), SETTLE));
      y.set(withSpring(zoom === 1 ? 0 : clamp(y.get(), limit(height, zoom)), SETTLE));
    };

    const pinch = Gesture.Pinch()
      .onStart((event) => {
        fromScale.set(scale.get());
        fromX.set(x.get());
        fromY.set(y.get());
        focalX.set(event.focalX - width / 2);
        focalY.set(event.focalY - height / 2);
      })
      .onUpdate((event) => {
        const zoom = Math.min(ZOOM_MAX * 1.25, Math.max(0.7, fromScale.get() * event.scale));
        const ratio = zoom / fromScale.get();
        scale.set(zoom);
        // Keeps the point between the fingers under the fingers.
        x.set(focalX.get() - (focalX.get() - fromX.get()) * ratio);
        y.set(focalY.get() - (focalY.get() - fromY.get()) * ratio);
      })
      .onEnd(settle);

    const pan = Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event) => {
        const touch = event.allTouches[0];
        if (!touch) return;
        downX.set(touch.absoluteX);
        downY.set(touch.absoluteY);
      })
      .onTouchesMove((event, state) => {
        if (dragging.get() || event.numberOfTouches !== 1) return;
        const touch = event.allTouches[0];
        if (!touch) return;
        const dx = Math.abs(touch.absoluteX - downX.get());
        const dy = Math.abs(touch.absoluteY - downY.get());
        if (scale.get() > 1.01) {
          // Zoomed in: any drag moves the picture.
          if (dx > 4 || dy > 4) state.activate();
        } else if (dy > 12 && dy > dx * 1.5) {
          // Normal size, clearly vertical: putting the picture away.
          state.activate();
        } else if (dx > 12) {
          // Sideways at normal size belongs to the pager.
          state.fail();
        }
      })
      .onStart((event) => {
        dragging.set(true);
        fromX.set(x.get());
        fromY.set(y.get());
        // What the finger had already travelled when the drag was recognized.
        slipX.set(event.translationX);
        slipY.set(event.translationY);
      })
      .onUpdate((event) => {
        const zoom = scale.get();
        const dx = event.translationX - slipX.get();
        const dy = event.translationY - slipY.get();
        if (zoom > 1.01) {
          x.set(clamp(fromX.get() + dx, limit(width, zoom)));
          y.set(clamp(fromY.get() + dy, limit(height, zoom)));
        } else {
          y.set(dy);
          pull.set(Math.abs(dy));
        }
      })
      .onEnd((event) => {
        if (scale.get() > 1.01) {
          settle();
          return;
        }
        const away = Math.abs(y.get()) > DISMISS_DISTANCE || Math.abs(event.velocityY) > DISMISS_VELOCITY;
        if (away) {
          y.set(withTiming(y.get() < 0 ? -height : height, { duration: 180 }));
          pull.set(withTiming(height, { duration: 180 }));
          scheduleOnRN(onDismiss);
        } else {
          y.set(withSpring(0, { duration: 350, dampingRatio: 0.85, velocity: event.velocityY }));
          pull.set(withTiming(0, { duration: 200 }));
        }
      })
      .onFinalize(() => {
        dragging.set(false);
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(260)
      .onEnd((event, success) => {
        if (!success) return;
        if (scale.get() > 1.01) {
          scale.set(withSpring(1, SETTLE));
          x.set(withSpring(0, SETTLE));
          y.set(withSpring(0, SETTLE));
          return;
        }
        // Zooms in on the spot that was tapped.
        const tapX = event.x - width / 2;
        const tapY = event.y - height / 2;
        scale.set(withSpring(ZOOM_DOUBLE_TAP, SETTLE));
        x.set(withSpring(clamp(-tapX * (ZOOM_DOUBLE_TAP - 1), limit(width, ZOOM_DOUBLE_TAP)), SETTLE));
        y.set(withSpring(clamp(-tapY * (ZOOM_DOUBLE_TAP - 1), limit(height, ZOOM_DOUBLE_TAP)), SETTLE));
      });

    const tap = Gesture.Tap()
      .maxDuration(260)
      .onEnd((_event, success) => {
        if (success) scheduleOnRN(onTap);
      });

    return Gesture.Race(Gesture.Simultaneous(pinch, pan), Gesture.Exclusive(doubleTap, tap));
    // The handlers are stable (see ImageViewer); the gesture is rebuilt only for a new page size.
  }, [width, height, onTap, onDismiss, pull, scale, x, y, fromScale, fromX, fromY, focalX, focalY, downX, downY, slipX, slipY, dragging]);

  // The pager stands still while a picture is zoomed, so a drag moves the picture, not the page.
  useAnimatedReaction(
    () => scale.get() > 1.01,
    (zoomed, before) => {
      if (zoomed !== before) scheduleOnRN(onZoom, zoomed);
    },
  );

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height }, imageStyle]}>
        {uri ? (
          <Image source={{ uri }} style={{ width, height }} contentFit="contain" accessibilityLabel={block.alt ?? "Shared image"} />
        ) : (
          <View style={[styles.viewerLoading, { width, height }]}>
            <ActivityIndicator color="#FFFFFF" />
          </View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * Full-screen gallery over one message's pictures.
 * Swipe between pictures, pinch or double tap to zoom, tap to hide the
 * buttons, drag a picture down to close. The backdrop fades as it is dragged.
 * Input: the pictures, which one to start on, the blob fetcher, and close.
 */
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
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const pull = useSharedValue(0);
  const caption = images[index]?.alt;
  // One identity each, so a page's gesture is not rebuilt when the buttons hide.
  const actions = useMemo(
    () => ({
      tap: () => setChrome((shown) => !shown),
      zoom: (now: boolean) => setZoomed(now),
      dismiss: () => setTimeout(onClose, 160),
    }),
    [onClose],
  );
  const save = (): void => {
    const block = images[index];
    if (!block || saving) return;
    setSaving(true);
    void imageAsFile(block, fetchBlob, index)
      .then((file) => (file ? shareFileBlock(file) : undefined))
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  const backdropStyle = useAnimatedStyle(() => ({ opacity: interpolate(pull.get(), [0, 320], [1, 0.25], "clamp") }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: interpolate(pull.get(), [0, 60], [1, 0], "clamp") }));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      {/* A Modal is its own window on Android, so gestures need their own root here. */}
      <GestureHandlerRootView style={styles.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.viewer, backdropStyle]} />
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          initialScrollIndex={start}
          initialNumToRender={1}
          windowSize={3}
          getItemLayout={(_data, item) => ({ length: width, offset: width * item, index: item })}
          keyExtractor={(_block, item) => String(item)}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <ViewerPage
              block={item}
              fetchBlob={fetchBlob}
              width={width}
              height={height}
              pull={pull}
              onTap={actions.tap}
              onZoom={actions.zoom}
              onDismiss={actions.dismiss}
            />
          )}
        />
        {chrome ? (
          <Animated.View style={[StyleSheet.absoluteFill, chromeStyle]} pointerEvents="box-none">
            <View style={[styles.viewerBar, { top: insets.top + 8 }]} pointerEvents="box-none">
              <Pressable style={styles.viewerButton} hitSlop={6} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
                <IconCloseLight />
              </Pressable>
              {images.length > 1 ? (
                <Text style={styles.viewerCount}>
                  {index + 1} / {images.length}
                </Text>
              ) : null}
              <Pressable style={styles.viewerButton} hitSlop={6} onPress={save} accessibilityRole="button" accessibilityLabel="Save image">
                {saving ? <ActivityIndicator color="#FFFFFF" size="small" /> : <IconDownloadLight />}
              </Pressable>
            </View>
            {caption ? (
              <Text style={[styles.viewerCaption, { bottom: insets.bottom + 16 }]} numberOfLines={3}>
                {caption}
              </Text>
            ) : null}
          </Animated.View>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

const VIDEO_NAME = /\.(mp4|m4v|mov)([?#]|$)/i;
const VIDEO_MIME: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v" };

const AUDIO_NAME = /\.(wav|mp3|m4a|aac|flac|caf|aiff?)([?#]|$)/i;
const AUDIO_MIME: Record<string, string> = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/vnd.wave": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/aiff": ".aiff",
  "audio/x-aiff": ".aiff",
};

/** True for sound files the system player can play in place. */
export function isAudioBlock(block: FileBlock): boolean {
  if ((block.mime ?? "").toLowerCase() in AUDIO_MIME) return true;
  return AUDIO_NAME.test(block.name) || (/^https?:\/\//i.test(block.url) && AUDIO_NAME.test(block.url));
}

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
export async function materializeFile(
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
  const kind = (mime ?? "").toLowerCase();
  const extension = VIDEO_MIME[kind] ?? AUDIO_MIME[kind];
  if (keep && extension && !VIDEO_NAME.test(name) && !AUDIO_NAME.test(name)) name = `${name}${extension}`;
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

const VIDEO_HEIGHT = 150;
const VIDEO_MAX_HEIGHT = 320;

function InlineVideo({
  uri,
  headers,
  onShape,
}: {
  uri: string;
  headers?: Record<string, string>;
  /** Told the video's real size once it is known. */
  onShape: (width: number, height: number) => void;
}) {
  // With headers the player streams from the core and asks for the parts it needs.
  const player = useVideoPlayer(headers ? { uri, headers } : uri, (created) => {
    created.play();
  });
  useEventListener(player, "sourceLoad", (loaded) => {
    const size = loaded.availableVideoTracks[0]?.size;
    if (size && size.width > 0 && size.height > 0) onShape(size.width, size.height);
  });
  const release = (): void => {
    innerTouching.value = false;
  };
  return (
    // The system player brings its own controls on both platforms: play,
    // scrub, mute and full screen. The app adds none of its own.
    <VideoView
      player={player}
      style={styles.fill}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      allowsPictureInPicture={false}
      // The player takes its own touches instead of leaving them to the bubble
      // around it. On Android the view that holds a touch takes every move of
      // the finger away from the views inside it. The bubble is a pressable,
      // so it held the touch, and the player never saw a tap finish: its
      // controls did not come up and the time bar could not be dragged.
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => true}
      // While a finger is on the player, a sideways drag is a scrub, not a reply.
      onResponderGrant={() => {
        innerTouching.value = true;
      }}
      onResponderRelease={release}
      onResponderTerminate={release}
    />
  );
}

/**
 * Plays a video the agent sent, in the bubble, with the system player.
 * Why: a video used to be a "Tap to open" file row that left the chat. The
 * poster costs nothing; the bytes load and the player starts on the first tap,
 * so a thread full of videos does not hold a decoder each. Once it plays, the
 * box takes the video's own shape, so a tall clip is not shown as a strip.
 * Full screen is the player's own button. Saving is not something the system
 * player offers, so that one stays here, beside the name.
 * Input: a video file block + blob fetcher. Output: poster, then the player.
 */
export function VideoBlock({ block, fetchBlob }: { block: FileBlock; fetchBlob?: FetchBlob }) {
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  const uri = source?.uri ?? null;
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(VIDEO_HEIGHT);

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
      <View style={[styles.video, { height }]}>
        {uri ? (
          <InlineVideo
            uri={uri}
            headers={source?.headers}
            onShape={(width, tall) =>
              setHeight(Math.round(Math.min(VIDEO_MAX_HEIGHT, Math.max(VIDEO_HEIGHT, (ALBUM_WIDTH * tall) / width))))
            }
          />
        ) : (
          <Pressable style={styles.poster} onPress={start} accessibilityRole="button" accessibilityLabel={`Play ${block.name}`}>
            <View style={styles.playDisk}>{busy ? <ActivityIndicator color="#FFFFFF" /> : <IconPlay />}</View>
          </Pressable>
        )}
      </View>
      <View style={styles.videoBar}>
        <Text style={[styles.caption, styles.videoName]} numberOfLines={1}>
          {failed ? "Could not load this video. Tap to retry." : block.name}
        </Text>
        <Pressable style={styles.videoAction} hitSlop={8} accessibilityRole="button" accessibilityLabel="Save video" onPress={save}>
          {saving ? <ActivityIndicator color={colors.text} size="small" /> : <IconDownload />}
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ColorPalette) {
  return StyleSheet.create({
    thumb: { borderRadius: 18, overflow: "hidden", backgroundColor: colors.bubble, alignItems: "center", justifyContent: "center" },
    thumbPlay: { width: 46, height: 46, borderRadius: 23, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
    mediaWrap: { gap: 6 },
    fill: { flex: 1 },
    single: { width: ALBUM_WIDTH, borderRadius: 12, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.control },
    singleLoading: { height: 180, alignItems: "center", justifyContent: "center" },
    tilePressed: { opacity: 0.85 },
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
    viewer: { backgroundColor: "#000000" },
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
    video: { width: ALBUM_WIDTH, borderRadius: 12, borderCurve: "continuous", overflow: "hidden", backgroundColor: "#000000" },
    poster: { flex: 1, alignItems: "center", justifyContent: "center" },
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
