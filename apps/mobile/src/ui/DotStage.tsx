import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Asset } from "expo-asset";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { markStyleGender, type MarkGender, type MarkMaterial, type MarkShape, type MarkStyle } from "@kuru/shared";
import { hydrateMarkThumbsFromDisk, persistMarkThumb } from "./mark-thumb-disk";
import { ShapeGlyph } from "./ShapeGlyph";

const studioModule = require("../../assets/dot-avatar-maker.html") as number;

/** Below this width (px), avatars use one shared bakery PNG; at/above, a live WebGL view. */
export const MARK_LIVE_MIN_PX = 96;
const LIVE_AT = MARK_LIVE_MIN_PX;

type Job = {
  shape: string;
  color: string;
  material: string;
  style: MarkStyle;
  gender: MarkGender;
};

const STYLE_GENDER_JSON = JSON.stringify(markStyleGender);

let htmlCache: Promise<string> | null = null;
export function studioHtml(): Promise<string> {
  if (!htmlCache) {
    htmlCache = (async () => {
      const asset = Asset.fromModule(studioModule);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      if (!uri) throw new Error("Dot studio asset missing");
      if (Platform.OS === "web") {
        const res = await fetch(uri);
        if (!res.ok) throw new Error(`Dot studio asset failed (${res.status})`);
        return res.text();
      }
      const { File } = await import("expo-file-system");
      return new File(uri).text();
    })();
  }
  return htmlCache;
}

// Warm the bundled studio as soon as this module loads.
void studioHtml();

function boot(job: Job, motion: boolean): string {
  const view = { ...job, motion };
  return `window.DOT_VIEW=${JSON.stringify(view)};window.DOT_MARK=true;`;
}

function apply(job: Job): string {
  const { shape, color, material, style, gender } = job;
  return `(function(){
    var d=window.__dot; if(!d) return false;
    var g=${JSON.stringify(gender)};
    var st=${JSON.stringify(style)};
    if(d.state.gender!==g) d.state.gender=g;
    var map=${STYLE_GENDER_JSON};
    function fits(id,gg){
      var sg=map[id];
      if(!sg) return true;
      return sg===(gg==='female'?'f':'m');
    }
    if(!fits(st,g)) st= g==='female'?'lady':'minimal';
    d.setOption('shape',${JSON.stringify(shape)});
    d.setOption('material',${JSON.stringify(material)});
    d.setOption('style',st);
    d.setColor(${JSON.stringify(color)});
    return true;
  })()`;
}

/** Live preview: rebuild in-page, then ping RN after the mesh settles (paint only fires once at boot). */
function applyLive(job: Job): string {
  return `${apply(job)};
    setTimeout(function(){
      try{ if(window.__dot&&window.__dot.main) window.__dot.main.render(); }catch(e){}
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'paint'}));
    }, 320);
    true;`;
}

const cache = new Map<string, string>();
const cacheListeners = new Set<() => void>();
const waiters = new Map<string, Array<(url: string | null) => void>>();
const jobs = new Map<string, Job>();
const order: string[] = [];
let web: WebView | null = null;
let studioReady = false;
let inflight: string | null = null;
let bakeryMounts = 0;
let lastBakedKey: string | null = null;

export function markThumbKey(job: Job): string {
  return `${job.shape}|${job.color.toUpperCase()}|${job.material}|${job.style}|${job.gender}`;
}

function keyOf(job: Job): string {
  return markThumbKey(job);
}

let notifyScheduled = false;

function notifyThumbCache(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  requestAnimationFrame(() => {
    notifyScheduled = false;
    for (const listen of cacheListeners) listen();
  });
}

let diskHydrated = false;

/**
 * Restores baked PNG URIs from disk into the in-memory cache (call once at app boot).
 */
export function hydrateMarkThumbCache(): void {
  if (diskHydrated) return;
  diskHydrated = true;
  void hydrateMarkThumbsFromDisk((key, fileUri) => {
    if (!cache.has(key)) cache.set(key, fileUri);
  }).then(() => notifyThumbCache());
}

/** Re-renders thumb views when a new PNG lands (memory or disk). */
export function subscribeMarkThumbCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

export function peekMarkThumb(
  look: { shape: MarkShape; color: string; material: MarkMaterial; style: MarkStyle; gender: MarkGender },
): string | null {
  return cache.get(keyOf(look)) ?? null;
}

/**
 * Queues bakery PNGs for roster marks so list/chat avatars hit cache before paint.
 * Input: resolved mark looks. Output: nothing.
 */
export function warmMarkThumbs(
  looks: { shape: MarkShape; color: string; material: MarkMaterial; style: MarkStyle; gender: MarkGender }[],
  opts?: { prioritize?: boolean },
): void {
  const seen = new Set<string>();
  for (const look of looks) {
    const job = {
      shape: look.shape,
      color: look.color,
      material: look.material,
      style: look.style,
      gender: look.gender,
    };
    const key = keyOf(job);
    if (seen.has(key) || cache.has(key)) continue;
    seen.add(key);
    enqueue(job, () => {});
    if (opts?.prioritize) {
      const at = order.indexOf(key);
      if (at > 0) {
        order.splice(at, 1);
        order.unshift(key);
      }
    }
  }
}

function pump(): void {
  if (!studioReady || !web || inflight) return;
  const key = order.find((item) => waiters.has(item) && !cache.has(item));
  if (!key) return;
  const job = jobs.get(key);
  if (!job) return;
  inflight = key;
  const script =
    lastBakedKey === key
      ? `setTimeout(function(){
      var url=null; try{ url=window.__dot&&window.__dot.snapshot(320); }catch(e){}
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'shot',key:${JSON.stringify(key)},url:url}));
    }, 120); true;`
      : `${apply(job)};
    setTimeout(function(){
      var url=null; try{ url=window.__dot&&window.__dot.snapshot(320); }catch(e){}
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'shot',key:${JSON.stringify(key)},url:url}));
    }, 200);
    true;`;
  web.injectJavaScript(script);
}

function enqueue(job: Job, done: (url: string | null) => void): () => void {
  const key = keyOf(job);
  const hit = cache.get(key);
  if (hit) {
    done(hit);
    return () => {};
  }
  const list = waiters.get(key) ?? [];
  list.push(done);
  waiters.set(key, list);
  if (!jobs.has(key)) {
    jobs.set(key, job);
    order.push(key);
  }
  pump();
  return () => {
    const next = (waiters.get(key) ?? []).filter((fn) => fn !== done);
    if (next.length) waiters.set(key, next);
    else waiters.delete(key);
  };
}

function onBakeryMessage(event: WebViewMessageEvent): void {
  let msg: { type?: string; key?: string; url?: string | null } = {};
  try {
    msg = JSON.parse(event.nativeEvent.data) as typeof msg;
  } catch {
    return;
  }
  if (msg.type === "ready") {
    studioReady = true;
    pump();
    return;
  }
  if (msg.type !== "shot" || !msg.key || msg.key !== inflight) return;
  if (msg.url) {
    const stored = persistMarkThumb(msg.key, msg.url) ?? msg.url;
    cache.set(msg.key, stored);
    lastBakedKey = msg.key;
    if (cache.size > 200) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    notifyThumbCache();
  }
  const pending = waiters.get(msg.key) ?? [];
  waiters.delete(msg.key);
  jobs.delete(msg.key);
  const at = order.indexOf(msg.key);
  if (at >= 0) order.splice(at, 1);
  inflight = null;
  for (const fn of pending) fn(msg.url ?? null);
  pump();
}

/** One studio WebView that bakes transparent PNGs for small marks. */
export function DotBakery() {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    bakeryMounts += 1;
    let alive = true;
    studioHtml()
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch(() => {});
    return () => {
      alive = false;
      bakeryMounts -= 1;
      if (bakeryMounts <= 0) {
        bakeryMounts = 0;
        studioReady = false;
        web = null;
        inflight = null;
      }
    };
  }, []);

  if (!html) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", width: 200, height: 200, left: 0, top: 0, opacity: 0.01, zIndex: -1 }}
    >
      <WebView
        ref={(node) => {
          web = node;
        }}
        source={{ html, baseUrl: "https://cdn.jsdelivr.net/" }}
        injectedJavaScriptBeforeContentLoaded={boot(
          { shape: "cloud", color: "#FFCC38", material: "plush", style: "gentleman", gender: "male" },
          false,
        )}
        injectedJavaScript={`(function wait(){ if(window.__dot&&window.__dot.snapshot){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'})); } else setTimeout(wait, 120); })(); true;`}
        onMessage={onBakeryMessage}
        originWhitelist={["*"]}
        scrollEnabled={false}
        mediaPlaybackRequiresUserAction={false}
        style={{ width: 200, height: 200, backgroundColor: "transparent" }}
        containerStyle={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

/** Still image of the real Dot character (same mesh + material as the hero). */
export function DotThumb({
  shape,
  color,
  material,
  style = "minimal",
  gender = "male",
  size,
  flatFallback = false,
}: {
  shape: MarkShape;
  color: string;
  material: MarkMaterial;
  style?: MarkStyle;
  gender?: MarkGender;
  size: number;
  /** When false, wait for the baked PNG instead of showing a flat silhouette. */
  flatFallback?: boolean;
}) {
  const job = { shape, color, material, style, gender };
  const [url, setUrl] = useState<string | null>(() => cache.get(keyOf(job)) ?? null);
  const shapeRef = useRef(shape);

  useEffect(() => subscribeMarkThumbCache(() => {
    const hit = cache.get(keyOf(job));
    if (hit) setUrl(hit);
  }), [shape, color, material, style, gender]);

  useEffect(() => {
    const hit = cache.get(keyOf(job));
    if (hit) {
      setUrl(hit);
      shapeRef.current = shape;
      return;
    }
    if (shapeRef.current !== shape) {
      setUrl(null);
      shapeRef.current = shape;
    }
    let active = true;
    const stop = enqueue(job, (next) => {
      if (active && next) setUrl(next);
    });
    return () => {
      active = false;
      stop();
    };
  }, [shape, color, material, style, gender]);

  const cacheKey = markThumbKey(job);

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" }}>
      {url ? (
        <Image
          source={{ uri: url }}
          cachePolicy="memory-disk"
          recyclingKey={cacheKey}
          style={{ width: size, height: size, backgroundColor: "transparent" }}
          contentFit="contain"
        />
      ) : flatFallback ? (
        <ShapeGlyph shape={shape} color={color} size={size} />
      ) : null}
    </View>
  );
}

/** Live Dot studio viewer. Glyph stays on top until the first 3D frame (no white flash). */
export function DotLive({
  shape,
  color,
  material,
  style = "minimal",
  gender = "male",
  size,
}: {
  shape: MarkShape;
  color: string;
  material: MarkMaterial;
  style?: MarkStyle;
  gender?: MarkGender;
  size: number;
}) {
  const ref = useRef<WebView>(null);
  const ready = useRef(false);
  const jobRef = useRef({ shape, color, material, style, gender });
  jobRef.current = { shape, color, material, style, gender };
  const [html, setHtml] = useState<string | null>(null);
  /** Baked PNG covers live boot until the first GL frame (same mesh as lists). */
  const [bootCover, setBootCover] = useState(true);
  const [glVisible, setGlVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    studioHtml()
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready.current) return;
    ref.current?.injectJavaScript(applyLive(jobRef.current));
  }, [shape, color, material, style, gender]);

  function onLiveMessage(event: WebViewMessageEvent): void {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type?: string };
      if (msg.type === "paint") {
        setBootCover(false);
        setGlVisible(true);
      }
    } catch {
      /* ignore */
    }
  }

  return (
    <View
      pointerEvents={size < 56 ? "none" : "auto"}
      style={{ width: size, height: size, backgroundColor: "transparent" }}
    >
      {bootCover ? (
        <View style={[StyleSheet.absoluteFill, styles.glyphCenter, { zIndex: 2 }]}>
          <DotThumb shape={shape} color={color} material={material} style={style} gender={gender} size={size} />
        </View>
      ) : null}
      {html ? (
        <WebView
          ref={ref}
          source={{ html, baseUrl: "https://cdn.jsdelivr.net/" }}
          injectedJavaScriptBeforeContentLoaded={boot(jobRef.current, true)}
          onLoadEnd={() => {
            ready.current = true;
            ref.current?.injectJavaScript(applyLive(jobRef.current));
          }}
          onMessage={onLiveMessage}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          style={{
            width: size,
            height: size,
            backgroundColor: "transparent",
            opacity: glVisible ? 1 : 0,
          }}
          containerStyle={{ backgroundColor: "transparent" }}
        />
      ) : null}
    </View>
  );
}

export function isLiveMark(size: number): boolean {
  return size >= LIVE_AT;
}

const styles = StyleSheet.create({
  glyphCenter: { alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
});
