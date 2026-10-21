import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { novncRoot, novncShell, novncShellScript } from "./novnc.js";

/**
 * Locks the viewer page contract. The phone loads this document into a WebView
 * and the shell opens the socket, so both the URL shape and the module imports
 * are load-bearing: a wrong asset prefix fails only on a device.
 */
describe("novnc viewer page", () => {
  it("resolves the installed client library", () => {
    const root = novncRoot();
    expect(root).not.toBeNull();
    expect(existsSync(join(root ?? "", "core", "rfb.js"))).toBe(true);
    expect(existsSync(join(root ?? "", "vendor", "pako", "lib", "zlib", "inflate.js"))).toBe(true);
  });

  it("imports RFB as a default export from the served asset path", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain('import RFB from "/assets/novnc/core/rfb.js"');
    expect(script).not.toContain("import { RFB }");
  });

  it("loads the driver as a module file so a strict CSP can run it", () => {
    const shell = novncShell("/assets/novnc");
    expect(shell).toContain('<script type="module" src="/assets/novnc/shell.js"></script>');
    expect(shell).not.toContain("<script type=\"module\">");
  });

  it("reads the socket endpoint from the url parameter", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain('params.get("url")');
    expect(script).toContain("new RFB(screen, url");
  });

  it("reports state back to the phone and tolerates a missing bridge", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain("window.ReactNativeWebView.postMessage");
    expect(script).toContain("window.nanoRfb = rfb");
    for (const kind of ["connect", "disconnect", "clipboard", "securityfailure", "credentialsrequired"]) {
      expect(script).toContain(`"${kind}"`);
    }
  });

  it("normalizes a trailing slash in the asset prefix", () => {
    expect(novncShellScript("/assets/novnc/")).toContain('import RFB from "/assets/novnc/core/rfb.js"');
    expect(novncShell("/assets/novnc/")).toContain('src="/assets/novnc/shell.js"');
  });

  it("supports optional trackpad mode and runtime pointer controls", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain('params.get("trackpad") === "1"');
    expect(script).toContain("window.nanoSetTrackpad");
    expect(script).toContain("window.nanoTouch");
    expect(script).toContain("window.nanoResetZoom");
    expect(script).toContain("window.nanoRecenterPointer");
    expect(script).toContain("window.ReactNativeWebView");
    expect(script).toContain("rfb.showDotCursor = true");
  });

  it("is valid JavaScript once the import is set aside", () => {
    const body = novncShellScript("/assets/novnc").replace(/^import .*$/m, "");
    expect(() => new Function(body)).not.toThrow();
  });

  it("separates a refused socket from an ordinary disconnect", () => {
    const script = novncShellScript("/assets/novnc");
    // A socket that never connected means the core rejected the page's cookie,
    // which the phone must report instead of showing "Connecting" forever.
    expect(script).toContain('kind: everConnected ? "disconnect" : "auth"');
    // The phone needs a way to see whether the viewer is merely mirroring.
    expect(script).toContain('let viewOnly = params.get("viewOnly") !== "0"');
    expect(script).toContain("rfb.viewOnly = viewOnly");
  });

  it("handles the clipboard itself inside the app's frame, and switches control on a message", () => {
    const script = novncShellScript("/assets/novnc");
    // The app cannot run code in this page, so paste, copy and control live here.
    expect(script).toContain('window.addEventListener(\n    "paste"');
    expect(script).toContain("navigator.clipboard.writeText(text)");
    expect(script).toContain('message.kind !== "control"');
    // Only the app's own page may switch control.
    expect(script).toContain("event.origin !== window.location.origin");
  });

  it("waits for the phone to plant the session before connecting", () => {
    const script = novncShellScript("/assets/novnc");
    // Constructing RFB before the cookie exists loses the race on iOS, where
    // scripts injected before content load run before the origin is committed.
    expect(script).toContain("window.__nanoSessionReady");
    expect(script).toContain("window.__nanoNoSession");
    expect(script).toContain("withSession(begin)");
    // The wait has to end, or a phone that never signs in hangs forever.
    expect(script).toContain("Date.now() > deadline");
    expect(script).toMatch(/clearInterval/);
    // The socket must only be created inside the deferred start path.
    const connect = script.indexOf("withSession(begin)");
    const construct = script.indexOf("new RFB(");
    expect(construct).toBeLessThan(connect);
  });
});

/**
 * Runs the viewer script against a stand-in screen, so the gestures can be
 * checked without a browser. The stand-in records every pointer message.
 */
function viewer(trackpad: boolean) {
  const sent: { x: number; y: number; mask: number }[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const rfb = {
    _fbWidth: 1280,
    _fbHeight: 800,
    _rfbConnectionState: "connected",
    viewOnly: false,
    _gestures: { detach: () => {} },
    _cursor: { move: () => {} },
    _sendMouse: (x: number, y: number, mask: number) => sent.push({ x: Math.round(x), y: Math.round(y), mask }),
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    focus: () => {},
  };
  const screenStyle: Record<string, string> = {};
  const win: Record<string, unknown> = {
    innerWidth: 400,
    innerHeight: 600,
    location: { search: `?url=ws://host/x&viewOnly=0&trackpad=${trackpad ? "1" : "0"}`, host: "host" },
    __nanoSessionReady: true,
    addEventListener: () => {},
  };
  const doc = { getElementById: () => ({ style: screenStyle }), addEventListener: () => {} };
  const body = novncShellScript("/assets/novnc").replace(/^import .*$/m, "");
  new Function("window", "document", "RFB", body)(win, doc, function () {
    return rfb;
  });
  listeners.get("connect")!({});
  sent.length = 0;
  const touch = (phase: string, ...points: number[]) => (win.nanoTouch as (phase: string, flat: number[]) => void)(phase, points);
  return { sent, touch, screenStyle };
}

describe("desktop gestures", () => {
  // A 1280x800 screen fitted into a 400x600 stage: 400x250, starting 175 down.
  it("turns a tap into a held left click under the finger", () => {
    vi.useFakeTimers();
    const { sent, touch } = viewer(false);
    touch("start", 200, 300);
    touch("end");
    expect(sent.at(-1)).toEqual({ x: 200, y: 125, mask: 1 });
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toEqual({ x: 200, y: 125, mask: 0 });
    vi.useRealTimers();
  });

  it("turns a long press and a two-finger tap into a right click", () => {
    vi.useFakeTimers();
    const { sent, touch } = viewer(false);
    touch("start", 200, 300);
    vi.advanceTimersByTime(600);
    expect(sent.some((event) => event.mask === 4)).toBe(true);
    touch("end");
    vi.advanceTimersByTime(100);
    expect(sent.filter((event) => event.mask === 1)).toEqual([]);

    sent.length = 0;
    touch("start", 200, 300);
    touch("start", 200, 300, 240, 300);
    touch("end", 240, 300);
    touch("end");
    vi.advanceTimersByTime(100);
    expect(sent.filter((event) => event.mask !== 0).map((event) => event.mask)).toEqual([4]);
    vi.useRealTimers();
  });

  it("moves the pointer without pressing in trackpad mode, and scrolls with two fingers", () => {
    const { sent, touch } = viewer(true);
    touch("start", 100, 100);
    touch("move", 150, 100);
    touch("end");
    expect(sent.every((event) => event.mask === 0)).toBe(true);
    // 50 stage px at a scale of 400/1280 moves the pointer 160 screen px, which is 50 px in the picture.
    expect(sent.at(-1)).toEqual({ x: 250, y: 125, mask: 0 });

    sent.length = 0;
    touch("start", 100, 300);
    touch("start", 100, 300, 140, 300);
    touch("move", 100, 250, 140, 250);
    touch("end");
    // Fingers moving up push the page up, which is wheel down.
    expect(sent.some((event) => event.mask === 16)).toBe(true);
    expect(sent.some((event) => event.mask === 4)).toBe(false);
  });

  it("zooms the view with a pinch instead of sending anything to the screen", () => {
    const { sent, touch, screenStyle } = viewer(false);
    touch("start", 180, 300);
    touch("start", 180, 300, 220, 300);
    sent.length = 0;
    touch("move", 140, 300, 260, 300);
    touch("end");
    expect(screenStyle.width).toBe("1200px");
    expect(sent.filter((event) => event.mask !== 0)).toEqual([]);
  });
});

/**
 * Runs the viewer as the web and desktop app shows it: in a frame of the
 * app's page, on a Mac or not. Records keys sent to the screen and text
 * written to the person's clipboard.
 */
function framedViewer({ mac, viewOnly = false }: { mac: boolean; viewOnly?: boolean }) {
  const keys: { keysym: number; code: string; down?: boolean }[] = [];
  const copied: string[] = [];
  const rfbListeners = new Map<string, (event: unknown) => void>();
  const winListeners = new Map<string, (event: unknown) => void>();
  const rfb = {
    _fbWidth: 1280,
    _fbHeight: 800,
    _rfbConnectionState: "connected",
    viewOnly: false,
    _gestures: { detach: () => {} },
    _cursor: { move: () => {} },
    _sendMouse: () => {},
    sendKey: (keysym: number, code: string, down?: boolean) => keys.push({ keysym, code, down }),
    clipboardPasteFrom: () => {},
    addEventListener: (type: string, handler: (event: unknown) => void) => rfbListeners.set(type, handler),
    focus: () => {},
  };
  const parent = { postMessage: () => {} };
  const win: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    parent,
    location: { search: `?url=ws://host/x&viewOnly=${viewOnly ? "1" : "0"}`, host: "host", origin: "https://kuru.test" },
    __nanoSessionReady: true,
    addEventListener: (type: string, handler: (event: unknown) => void) => winListeners.set(type, handler),
  };
  const doc = { getElementById: () => ({ style: {} }), addEventListener: () => {} };
  const nav = {
    platform: mac ? "MacIntel" : "Win32",
    clipboard: { writeText: async (text: string) => void copied.push(text) },
  };
  const body = novncShellScript("/assets/novnc").replace(/^import .*$/m, "");
  new Function("window", "document", "navigator", "RFB", body)(win, doc, nav, function () {
    return rfb;
  });
  rfbListeners.get("connect")!({});
  const event = (fields: Record<string, unknown>) => {
    const flags = { prevented: false, stopped: false };
    return {
      ...fields,
      flags,
      preventDefault: () => (flags.prevented = true),
      stopImmediatePropagation: () => (flags.stopped = true),
    };
  };
  const fire = (type: string, fields: Record<string, unknown>) => {
    const made = event(fields);
    winListeners.get(type)?.(made);
    return made.flags;
  };
  const paste = (text: string) => fire("paste", { clipboardData: { getData: () => text } });
  return { rfb, keys, copied, parent, fire, paste, rfbListeners };
}

describe("clipboard and control in the app's frame", () => {
  it("types pasted text, letting go of Ctrl, Alt, Cmd and Super first", () => {
    const { keys, paste } = framedViewer({ mac: false });
    const flags = paste("Hi\n");
    expect(flags.prevented).toBe(true);
    const released = keys.filter((key) => key.down === false).map((key) => key.keysym);
    expect(released).toEqual(expect.arrayContaining([0xffe3, 0xffe4, 0xffe9, 0xffe7, 0xffeb]));
    const typed = keys.filter((key) => key.down === undefined).map((key) => key.keysym);
    expect(typed).toEqual([0x48, 0x69, 0xff0d]);
  });

  it("keeps Ctrl+V from the screen so the browser pastes instead", () => {
    const { keys, fire } = framedViewer({ mac: false });
    const flags = fire("keydown", { key: "v", ctrlKey: true, metaKey: false });
    expect(flags.stopped).toBe(true);
    // Not prevented: the browser must still paste, which fires the paste event.
    expect(flags.prevented).toBe(false);
    expect(keys).toEqual([]);
  });

  it("turns a Mac's Cmd+C into Ctrl+C on the agent's Linux, and keeps Cmd itself back", () => {
    const { keys, fire } = framedViewer({ mac: true });
    expect(fire("keydown", { key: "Meta", metaKey: true, ctrlKey: false }).stopped).toBe(true);
    fire("keydown", { key: "c", metaKey: true, ctrlKey: false });
    expect(keys).toEqual([
      { keysym: 0xffe3, code: "ControlLeft", down: true },
      { keysym: 0x63, code: "", down: undefined },
      { keysym: 0xffe3, code: "ControlLeft", down: false },
    ]);
  });

  it("leaves Cmd+Q, Cmd+W, Cmd+H and Cmd+M to the Mac", () => {
    const { keys, fire } = framedViewer({ mac: true });
    const flags = fire("keydown", { key: "q", metaKey: true, ctrlKey: false });
    expect(flags).toEqual({ prevented: false, stopped: true });
    expect(keys).toEqual([]);
  });

  it("puts what is copied on the agent's computer on the person's clipboard", () => {
    const { copied, rfbListeners } = framedViewer({ mac: true });
    rfbListeners.get("clipboard")!({ detail: { text: "from linux" } });
    expect(copied).toEqual(["from linux"]);
  });

  it("switches between watching and controlling on a message from the app's own page", () => {
    const { rfb, keys, parent, fire, paste } = framedViewer({ mac: false, viewOnly: true });
    expect(rfb.viewOnly).toBe(true);
    paste("ignored while watching");
    expect(keys).toEqual([]);
    // Another site, or another frame, cannot take control.
    fire("message", { source: parent, origin: "https://evil.test", data: JSON.stringify({ kind: "control", on: true }) });
    fire("message", { source: {}, origin: "https://kuru.test", data: JSON.stringify({ kind: "control", on: true }) });
    expect(rfb.viewOnly).toBe(true);
    fire("message", { source: parent, origin: "https://kuru.test", data: JSON.stringify({ kind: "control", on: true }) });
    expect(rfb.viewOnly).toBe(false);
    fire("message", { source: parent, origin: "https://kuru.test", data: JSON.stringify({ kind: "control", on: false }) });
    expect(rfb.viewOnly).toBe(true);
  });
});
