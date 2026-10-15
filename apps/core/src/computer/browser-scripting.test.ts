import { describe, expect, it } from "vitest";
import { drivesBrowserDirectly } from "./linux-tool-executes.js";

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
