import { describe, expect, it } from "vitest";
import { BATCH_VIEW_CHARS, batchPageView, drivesBrowserDirectly } from "./linux-tool-executes.js";

describe("drivesBrowserDirectly", () => {
  it("refuses scripts that drive the browser through its debugging port or CDP", () => {
    expect(drivesBrowserDirectly("python3 - <<'EOF'\nimport websockets\nresult = subprocess.run(['curl', '-s', 'http://localhost:9214/json'])\nEOF")).toBe(true);
    expect(drivesBrowserDirectly(`node -e "ws.send(JSON.stringify({method:'Input.dispatchMouseEvent'}))"`)).toBe(true);
    expect(drivesBrowserDirectly("node -e \"require('playwright').chromium.connectOverCDP('http://127.0.0.1:9212')\"")).toBe(true);
  });

  it("lets ordinary commands through", () => {
    expect(drivesBrowserDirectly("curl -s http://localhost:3000/health")).toBe(false);
    expect(drivesBrowserDirectly("ls ~/work/fiverr && cat gig2_content.md")).toBe(false);
    expect(drivesBrowserDirectly("ffmpeg -i in.mp4 -vf scale=1280:-2 out.mp4")).toBe(false);
  });
});

describe("batchPageView", () => {
  it("keeps a small page view whole", () => {
    expect(batchPageView("Changed since your last snapshot\n- button \"Reply\" [ref=e12]")).toBe("Changed since your last snapshot\n- button \"Reply\" [ref=e12]");
  });

  it("cuts a re-rendered thread to whole lines and says how to see the rest", () => {
    const view = Array.from({ length: 600 }, (_, i) => `- article "Comment ${i}" [ref=e${i}]`).join("\n");
    const out = batchPageView(view);
    expect(out.length).toBeLessThan(BATCH_VIEW_CHARS + 120);
    expect(out).toContain('- article "Comment 0" [ref=e0]');
    expect(out).toMatch(/\[\.\.\. \d+ more lines of the page not shown\. Take browser_snapshot/);
    expect(out.split("\n").at(-2)).toMatch(/^- article "Comment \d+" \[ref=e\d+\]$/);
  });
});
