import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

/** The message a page sends out, in the shape the phone's WebView reports it. */
export type WebFrameMessageEvent = { nativeEvent: { data: string } };
export type WebFrameHandle = { injectJavaScript: (script: string) => void };

type Props = {
  source: { html: string; baseUrl?: string } | { uri: string; headers?: Record<string, string> };
  injectedJavaScriptBeforeContentLoaded?: string;
  injectedJavaScript?: string;
  onMessage?: (event: WebFrameMessageEvent) => void;
  onLoadEnd?: () => void;
  onError?: () => void;
  style?: StyleProp<ViewStyle>;
  // Accepted so callers can pass the phone's options unchanged; an iframe has no use for them.
  originWhitelist?: string[];
  scrollEnabled?: boolean;
  bounces?: boolean;
  mediaPlaybackRequiresUserAction?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
};

let frames = 0;

/**
 * The browser's stand-in for the phone's WebView: an iframe.
 * A page given as HTML is written into the frame, so it shares this page's
 * origin and scripts can be run inside it. The page talks back through
 * `window.ReactNativeWebView.postMessage`, exactly as it does on a phone; here
 * that name is a small relay to the frame's parent.
 * A page given as an address is another site's page: it is shown, and its
 * messages are heard if it posts them to its parent, but scripts cannot be
 * run inside it.
 */
export const WebFrame = forwardRef<WebFrameHandle, Props>(function WebFrame(
  { source, injectedJavaScriptBeforeContentLoaded, injectedJavaScript, onMessage, onLoadEnd, onError, style },
  ref,
) {
  const frame = useRef<HTMLIFrameElement>(null);
  const id = useMemo(() => `frame-${(frames += 1)}`, []);
  const html = "html" in source ? source.html : null;
  const uri = "uri" in source ? source.uri : null;
  // What runs before the page's own scripts. Fixed at first render, like the phone's.
  const before = useRef(injectedJavaScriptBeforeContentLoaded ?? "");
  const document = useMemo(() => {
    if (html === null) return undefined;
    const relay = `window.ReactNativeWebView={postMessage:function(m){parent.postMessage({frame:${JSON.stringify(id)},data:String(m)},"*")}};`;
    return `<script>${relay}${before.current.replace(/<\/script/gi, "<\\/script")}</script>${html}`;
  }, [html, id]);

  const heard = useRef(onMessage);
  heard.current = onMessage;
  useEffect(() => {
    const listen = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      // A written page wraps its message with this frame's id; another site's page sends it bare.
      if (data && typeof data === "object" && (data as { frame?: string }).frame === id) {
        heard.current?.({ nativeEvent: { data: (data as { data: string }).data } });
      } else if (typeof data === "string") {
        heard.current?.({ nativeEvent: { data } });
      }
    };
    globalThis.addEventListener("message", listen);
    return () => globalThis.removeEventListener("message", listen);
  }, [id]);

  const run = (script: string): void => {
    try {
      (frame.current?.contentWindow as (Window & { eval: (code: string) => unknown }) | null)?.eval(script);
    } catch {
      // Another site's page, or a frame that is gone: nothing to run it in.
    }
  };
  useImperativeHandle(ref, () => ({ injectJavaScript: run }));

  const flat = (StyleSheet.flatten(style) ?? {}) as CSSProperties;
  return (
    <iframe
      ref={frame}
      title="Embedded view"
      src={uri ?? undefined}
      srcDoc={document}
      onLoad={() => {
        if (injectedJavaScript) run(injectedJavaScript);
        onLoadEnd?.();
      }}
      onError={onError}
      allow="autoplay; fullscreen; clipboard-read; clipboard-write"
      style={{ border: 0, display: "block", backgroundColor: "transparent", ...flat }}
    />
  );
});
