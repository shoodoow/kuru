/**
 * A web page inside the app. On a phone this is the system WebView. In a
 * browser (WebFrame.web.tsx) it is an iframe that answers to the same few
 * props and the same `injectJavaScript`, so the screens that use it are
 * written once.
 */
export { WebView as WebFrame, type WebViewMessageEvent as WebFrameMessageEvent } from "react-native-webview";
export type { WebView as WebFrameHandle } from "react-native-webview";
