import { useRef, type RefObject } from "react";
import { StyleSheet, View, type GestureResponderEvent, type ViewProps } from "react-native";
import type { WebView } from "react-native-webview";

/**
 * Full-stage touch surface for trackpad mode. The remote picture is often
 * letterboxed inside the WebView; this layer keeps receiving fingers anywhere
 * on the stage and reports them to the viewer page, which turns them into
 * pointer moves, clicks, scrolling and zoom (see the gesture notes in
 * apps/core/src/desktop/novnc.ts).
 *
 * Every finger still down is sent each time, so the page can tell one finger
 * from two: `start` when a finger lands, `end` when one lifts, `move` between.
 */
export function TrackpadCapture({
  webRef,
  ...rest
}: { webRef: RefObject<WebView | null> } & ViewProps) {
  const surface = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const down = useRef(0);

  function send(phase: "start" | "move" | "end" | "cancel", points: number[]): void {
    webRef.current?.injectJavaScript(
      `window.nanoTouch && window.nanoTouch("${phase}", [${points.join(",")}]); true;`,
    );
  }

  /** Reports the fingers in this event, relative to the stage (which the page fills). */
  function report(event: GestureResponderEvent): void {
    const points = event.nativeEvent.touches.flatMap((touch) => [
      Math.round(touch.pageX - origin.current.x),
      Math.round(touch.pageY - origin.current.y),
    ]);
    const count = points.length / 2;
    const phase = count > down.current ? "start" : count < down.current ? "end" : "move";
    down.current = count;
    send(phase, points);
  }

  function cancel(): void {
    down.current = 0;
    send("cancel", []);
  }

  return (
    <View
      {...rest}
      ref={surface}
      style={[StyleSheet.absoluteFill, rest.style]}
      collapsable={false}
      onLayout={() => {
        surface.current?.measureInWindow((x, y) => {
          origin.current = { x, y };
        });
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={report}
      onResponderStart={report}
      onResponderMove={report}
      onResponderEnd={report}
      onResponderRelease={report}
      onResponderTerminate={cancel}
    />
  );
}
