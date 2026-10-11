import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the noVNC client that ships in node_modules.
 * Input: nothing.
 * Output: the absolute path of the @novnc/novnc package root, or null when it
 * is not installed. The package blocks deep imports through its exports map,
 * so resolution walks up from this module instead of using require.resolve.
 */
export function novncRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "node_modules", "@novnc", "novnc");
    if (existsSync(join(candidate, "core", "rfb.js"))) {
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Builds the HTML shell that hosts the noVNC client inside the app's WebView.
 * Input: the path prefix the client resolves its module imports against.
 * Output: a complete HTML document. It carries no session data, so it is
 * safe to serve without a cookie; the RFB connection it opens is what the
 * core actually authorizes.
 */
export function novncShell(assetBase: string): string {
  const base = assetBase.replace(/\/+$/, "").replace(/[^A-Za-z0-9/_-]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Desktop</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; touch-action: none; }
  /* The script resizes and slides this box to zoom and pan the picture. */
  #screen { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; touch-action: none; transform-origin: 0 0; }
  #screen canvas { max-width: 100%; max-height: 100%; touch-action: none; }
</style>
</head>
<body>
<div id="screen"></div>
<script type="module" src="${base}/shell.js"></script>
</body>
</html>`;
}

/**
 * Builds the module the shell page loads.
 * Input: the path prefix the client resolves its module imports against.
 * Output: an ES module that drives noVNC and reports state to the phone.
 *
 * Kept as a separate file rather than an inline script so the page can run
 * under a script-src 'self' policy with no inline escape hatch.
 */
export function novncShellScript(assetBase: string): string {
  // Embedded as a JS string literal, so strip anything that could terminate it.
  const base = assetBase.replace(/\/+$/, "").replace(/[^A-Za-z0-9/_-]/g, "");
  return `import RFB from "${base}/core/rfb.js";

const post = (payload) => {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
};

const screen = document.getElementById("screen");
const params = new URLSearchParams(window.location.search);
const url = params.get("url");
const passed = params.get("password") ?? "";

window.nanoRfb = null;

/**
 * Waits for the phone to plant the session cookie.
 *
 * iOS runs scripts injected before content load in a document whose origin is
 * not committed yet, and a cookie written there is discarded. The phone sets
 * the cookie again once the page has loaded and then raises this flag, so
 * connecting is deferred until a cookie is known to be readable rather than
 * racing the platform's document-start timing.
 */
const withSession = (start) => {
  if (window.__nanoNoSession) {
    post({ kind: "auth" });
    return;
  }
  if (window.__nanoSessionReady) {
    start();
    return;
  }
  const deadline = Date.now() + 20000;
  const poll = setInterval(() => {
    if (window.__nanoNoSession) {
      clearInterval(poll);
      post({ kind: "auth" });
    } else if (window.__nanoSessionReady) {
      clearInterval(poll);
      start();
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      post({ kind: "auth" });
    }
  }, 100);
};

let trackpadWanted = params.get("trackpad") === "1";

// ---- The view: local zoom and pan ----
// The remote screen is 1280 wide and a phone about 400, so text is unreadable
// at fit size. Zooming grows the box noVNC scales the picture into, which keeps
// its pointer maths right; panning slides that box under the stage.
const MAX_ZOOM = 5;
const view = { zoom: 1, x: 0, y: 0 };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Where the remote picture sits inside the zoomed box, in CSS px. */
const pictureBox = (rfb) => {
  const boxW = window.innerWidth * view.zoom;
  const boxH = window.innerHeight * view.zoom;
  const fbW = rfb._fbWidth || 1;
  const fbH = rfb._fbHeight || 1;
  const scale = Math.min(boxW / fbW, boxH / fbH);
  const w = fbW * scale;
  const h = fbH * scale;
  return { left: (boxW - w) / 2, top: (boxH - h) / 2, w, h, scale, boxW, boxH };
};

/** Keeps the picture on screen: centred when it fits, edge to edge when it does not. */
const clampPan = (pan, start, size, stage, box) =>
  size <= stage ? (box - stage) / 2 : clamp(pan, start, start + size - stage);

const applyView = (rfb) => {
  const box = pictureBox(rfb);
  view.x = clampPan(view.x, box.left, box.w, window.innerWidth, box.boxW);
  view.y = clampPan(view.y, box.top, box.h, window.innerHeight, box.boxH);
  screen.style.width = box.boxW + "px";
  screen.style.height = box.boxH + "px";
  screen.style.transform = "translate(" + -view.x + "px," + -view.y + "px)";
  placeCursor(rfb);
};

// ---- The pointer ----
// One remote pointer for both input modes, kept in remote-screen pixels.
const ptr = { x: null, y: null, mask: 0 };

const clientToFb = (rfb, clientX, clientY) => {
  const box = pictureBox(rfb);
  return { x: (clientX + view.x - box.left) / box.scale, y: (clientY + view.y - box.top) / box.scale };
};

const placeCursor = (rfb) => {
  if (ptr.x == null) {
    return;
  }
  const box = pictureBox(rfb);
  rfb._cursor.move(box.left + ptr.x * box.scale - view.x, box.top + ptr.y * box.scale - view.y);
};

/** Sends the pointer where it is, with these buttons held. */
const sendAt = (rfb, mask) => {
  const box = pictureBox(rfb);
  ptr.mask = mask & 7;
  rfb._sendMouse(ptr.x * box.scale, ptr.y * box.scale, mask);
};

const movePtr = (rfb, fbX, fbY) => {
  ptr.x = clamp(fbX, 0, (rfb._fbWidth || 1) - 1);
  ptr.y = clamp(fbY, 0, (rfb._fbHeight || 1) - 1);
  sendAt(rfb, ptr.mask);
  placeCursor(rfb);
};

/** While zoomed in, slides the view so the pointer never leaves it. */
const follow = (rfb) => {
  if (view.zoom <= 1 || ptr.x == null) {
    return;
  }
  const box = pictureBox(rfb);
  const edge = 48;
  const x = box.left + ptr.x * box.scale - view.x;
  const y = box.top + ptr.y * box.scale - view.y;
  const before = view.x + "," + view.y;
  if (x < edge) view.x -= edge - x;
  if (x > window.innerWidth - edge) view.x += x - (window.innerWidth - edge);
  if (y < edge) view.y -= edge - y;
  if (y > window.innerHeight - edge) view.y += y - (window.innerHeight - edge);
  if (before !== view.x + "," + view.y) {
    applyView(rfb);
  }
};

// A press and its release sent in the same instant can be missed by the
// desktop's panel and by some apps, so a click holds the button briefly.
const CLICK_HOLD = 70;
const click = (rfb, button) => {
  sendAt(rfb, 0);
  sendAt(rfb, button);
  setTimeout(() => sendAt(rfb, 0), CLICK_HOLD);
};

// Wheel buttons: 8 up, 16 down, 32 left, 64 right. Fingers moving down pull
// the page down with them, as on a phone.
const WHEEL_STEP = 14;
const wheelLeft = { x: 0, y: 0 };
const wheel = (rfb, dx, dy) => {
  wheelLeft.x += dx;
  wheelLeft.y += dy;
  while (Math.abs(wheelLeft.y) >= WHEEL_STEP) {
    sendAt(rfb, ptr.mask | (wheelLeft.y > 0 ? 8 : 16));
    sendAt(rfb, ptr.mask);
    wheelLeft.y -= Math.sign(wheelLeft.y) * WHEEL_STEP;
  }
  while (Math.abs(wheelLeft.x) >= WHEEL_STEP) {
    sendAt(rfb, ptr.mask | (wheelLeft.x > 0 ? 32 : 64));
    sendAt(rfb, ptr.mask);
    wheelLeft.x -= Math.sign(wheelLeft.x) * WHEEL_STEP;
  }
};

// ---- Gestures ----
// One finger: tap is a left click, a long press is a right click. In direct
// mode the pointer jumps under the finger and a drag holds the left button; in
// trackpad mode a drag moves the pointer, and tap-then-drag holds the button.
// Two fingers: a tap is a right click, a drag scrolls, a pinch zooms the view.
const TAP = 10;
const LONG = 500;
const DOUBLE = 350;
const PINCH = 24;
const g = { n: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, done: false, armed: false, drag: false, long: null, lastTap: 0, two: null };

const stopLong = () => {
  if (g.long) {
    clearTimeout(g.long);
    g.long = null;
  }
};

const endDrag = (rfb) => {
  if (g.drag) {
    g.drag = false;
    sendAt(rfb, 0);
  }
};

const oneStart = (rfb, p) => {
  g.startX = g.lastX = p.x;
  g.startY = g.lastY = p.y;
  g.moved = false;
  g.done = false;
  g.armed = trackpadWanted && Date.now() - g.lastTap < DOUBLE;
  if (!trackpadWanted) {
    const at = clientToFb(rfb, p.x, p.y);
    movePtr(rfb, at.x, at.y);
  }
  stopLong();
  g.long = setTimeout(() => {
    if (g.n === 1 && !g.moved && !g.done) {
      g.done = true;
      click(rfb, 4);
    }
  }, LONG);
};

const oneMove = (rfb, p) => {
  const dx = p.x - g.lastX;
  const dy = p.y - g.lastY;
  g.lastX = p.x;
  g.lastY = p.y;
  if (g.done) {
    return;
  }
  if (!g.moved) {
    if (Math.hypot(p.x - g.startX, p.y - g.startY) <= TAP) {
      return;
    }
    g.moved = true;
    stopLong();
    if (!trackpadWanted || g.armed) {
      g.drag = true;
      sendAt(rfb, 1);
    }
  }
  if (trackpadWanted) {
    const scale = pictureBox(rfb).scale;
    movePtr(rfb, ptr.x + dx / scale, ptr.y + dy / scale);
    follow(rfb);
  } else {
    const at = clientToFb(rfb, p.x, p.y);
    movePtr(rfb, at.x, at.y);
  }
};

const oneEnd = (rfb) => {
  stopLong();
  if (g.drag) {
    endDrag(rfb);
  } else if (!g.moved && !g.done) {
    click(rfb, 1);
    g.lastTap = Date.now();
  }
  g.done = true;
};

const twoStart = (rfb, a, b) => {
  stopLong();
  endDrag(rfb);
  // The one-finger gesture is over: lifting a finger later must not click.
  g.done = true;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  g.two = { d0: Math.hypot(a.x - b.x, a.y - b.y), zoom0: view.zoom, cx, cy, startX: cx, startY: cy, kind: null, at: Date.now() };
  wheelLeft.x = 0;
  wheelLeft.y = 0;
};

const twoMove = (rfb, a, b) => {
  const t = g.two;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  if (!t.kind) {
    if (Math.abs(d - t.d0) > PINCH) {
      t.kind = "pinch";
    } else if (Math.hypot(cx - t.startX, cy - t.startY) > TAP) {
      t.kind = "scroll";
    } else {
      return;
    }
  }
  if (t.kind === "pinch") {
    // The spot of the picture under the fingers stays under the fingers.
    const next = clamp((t.zoom0 * d) / t.d0, 1, MAX_ZOOM);
    const ux = (t.cx + view.x) / view.zoom;
    const uy = (t.cy + view.y) / view.zoom;
    view.zoom = next;
    view.x = ux * next - cx;
    view.y = uy * next - cy;
    applyView(rfb);
  } else {
    // Zoomed in, the drag slides the view first; what the view cannot take
    // (it is at its edge, or the picture already fits) scrolls the remote page.
    let dx = cx - t.cx;
    let dy = cy - t.cy;
    if (view.zoom > 1) {
      const beforeX = view.x;
      const beforeY = view.y;
      view.x -= dx;
      view.y -= dy;
      applyView(rfb);
      dx -= beforeX - view.x;
      dy -= beforeY - view.y;
    }
    wheel(rfb, dx, dy);
  }
  t.cx = cx;
  t.cy = cy;
};

const twoEnd = (rfb) => {
  const t = g.two;
  g.two = null;
  if (!t.kind && Date.now() - t.at < DOUBLE) {
    click(rfb, 4);
  }
};

/** Feeds the engine: phase is start, move, end or cancel; points are the fingers still down, in page px. */
const touch = (phase, points) => {
  const rfb = window.nanoRfb;
  if (!rfb || rfb.viewOnly || rfb._rfbConnectionState !== "connected" || ptr.x == null) {
    return;
  }
  const n = points.length;
  if (phase === "cancel") {
    stopLong();
    endDrag(rfb);
    g.two = null;
    g.done = true;
    g.n = 0;
    return;
  }
  if (phase === "start") {
    if (n === 1) {
      oneStart(rfb, points[0]);
    } else if (n === 2) {
      twoStart(rfb, points[0], points[1]);
    }
    g.n = n;
    return;
  }
  if (phase === "move") {
    if (n === 1 && g.n === 1) {
      oneMove(rfb, points[0]);
    } else if (n >= 2 && g.two) {
      twoMove(rfb, points[0], points[1]);
    }
    return;
  }
  if (g.two && n < 2) {
    twoEnd(rfb);
  }
  if (n === 0) {
    oneEnd(rfb);
  }
  g.n = n;
};

// The phone's trackpad surface sits over the page and reports fingers here, as
// a flat list of x, y pairs.
window.nanoTouch = (phase, flat) => {
  const points = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    points.push({ x: flat[i], y: flat[i + 1] });
  }
  touch(phase, points);
};

// Everywhere else the page hears the fingers itself. Listening on the document
// covers the bars around the picture as well as the picture.
for (const [type, phase] of [["touchstart", "start"], ["touchmove", "move"], ["touchend", "end"], ["touchcancel", "cancel"]]) {
  document.addEventListener(
    type,
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      touch(phase, Array.from(event.touches, (t) => ({ x: t.clientX, y: t.clientY })));
    },
    { passive: false, capture: true },
  );
}

window.addEventListener("resize", () => {
  if (window.nanoRfb && ptr.x != null) {
    applyView(window.nanoRfb);
  }
});

const centerPointer = (rfb) => {
  movePtr(rfb, (rfb._fbWidth || 1) / 2, (rfb._fbHeight || 1) / 2);
  follow(rfb);
};

/** Takes touch input over from noVNC once the screen is connected. */
const takeInput = (rfb) => {
  rfb._gestures.detach();
  rfb.showDotCursor = true;
  ptr.mask = 0;
  centerPointer(rfb);
  applyView(rfb);
};

window.nanoSetTrackpad = (on) => {
  trackpadWanted = !!on;
};

window.nanoRecenterPointer = () => {
  const rfb = window.nanoRfb;
  if (rfb && ptr.x != null) {
    centerPointer(rfb);
  }
};

window.nanoResetZoom = () => {
  const rfb = window.nanoRfb;
  view.zoom = 1;
  if (rfb && ptr.x != null) {
    applyView(rfb);
  }
};

const begin = () => {
  const rfb = new RFB(screen, url, { shared: true });
  window.nanoRfb = rfb;

  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.viewOnly = params.get("viewOnly") !== "0";
  rfb.showDotCursor = true;
  rfb.background = "#111";
  rfb.qualityLevel = 7;
  rfb.compressionLevel = 7;

  if (passed) {
    rfb.addEventListener("credentialsrequired", () => {
      rfb.sendCredentials({ password: passed });
    });
  }

  // A socket that drops before it ever connected was refused by the core, which
  // for this page means the session cookie did not arrive. That is a sign-in
  // problem, so it is reported apart from an ordinary disconnect to stop the
  // phone showing "Connecting" indefinitely.
  let everConnected = false;

  rfb.addEventListener("connect", () => {
    everConnected = true;
    takeInput(rfb);
    post({ kind: "connect" });
  });
  rfb.addEventListener("disconnect", () => post({ kind: everConnected ? "disconnect" : "auth" }));
  rfb.addEventListener("clipboard", (event) => post({ kind: "clipboard", text: event.detail.text }));
  rfb.addEventListener("bell", () => post({ kind: "bell" }));
  rfb.addEventListener("securityfailure", (event) => {
    post({ kind: "error", message: event.detail?.reason ?? "The desktop refused the connection." });
  });
  rfb.addEventListener("credentialsrequired", () => post({ kind: "credentials" }));
  rfb.focus();
};

// This page is served without a session, so the socket address in the query
// is not trusted: it may only point back at the server that served the page.
const sameServer = (() => {
  try {
    return new URL(url).host === window.location.host;
  } catch {
    return false;
  }
})();

if (!url) {
  post({ kind: "error", message: "Missing url." });
} else if (!sameServer) {
  post({ kind: "error", message: "The desktop address does not belong to this server." });
} else {
  withSession(begin);
}
`;
}

