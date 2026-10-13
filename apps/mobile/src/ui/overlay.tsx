import { useEffect, useState, type ReactElement } from "react";

type Render = (close: () => void) => ReactElement;

let present: ((render: Render) => void) | null = null;

/**
 * Shows a viewer (a file, a picture gallery) over the whole app.
 * Why: these used to be drawn inside the message bubble that opened them.
 * A bubble is a pressable with hold and swipe gestures, and everything drawn
 * inside it answers to those gestures first, wherever it appears on screen.
 * That is why a file's text would not scroll properly. Drawn from the top of
 * the app instead, a viewer owns its own touches.
 * Input: a function that draws the viewer and is handed the way to close it.
 */
export function presentOverlay(render: Render): void {
  present?.(render);
}

/** The one place viewers are drawn. Mounted once, above the navigation stack. */
export function OverlayHost() {
  const [shown, setShown] = useState<{ id: number; render: Render } | null>(null);
  useEffect(() => {
    let next = 0;
    present = (render) => {
      next += 1;
      setShown({ id: next, render });
    };
    return () => {
      present = null;
    };
  }, []);
  if (!shown) return null;
  const id = shown.id;
  const close = (): void => setShown((current) => (current?.id === id ? null : current));
  return <OverlayItem key={id} render={shown.render} close={close} />;
}

function OverlayItem({ render, close }: { render: Render; close: () => void }) {
  return render(close);
}
