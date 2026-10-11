import { describe, expect, it } from "vitest";
import {
  BROWSER_USER_AGENT,
  botWallMessage,
  htmlToMarkdown,
  safeUrl,
  unsupportedMimeMessage,
} from "./web.js";

/**
 * Locks web fetch guards and LLM-ready extraction: only public targets pass,
 * articles distill to structured Markdown (headings, lists, fenced code,
 * resolved links), and non-article pages fall back instead of vanishing.
 */
describe("web guards and extraction", () => {
  it("accepts public pages and refuses private ranges", () => {
    expect(safeUrl("https://www.skills.sh/")).toBe("https://www.skills.sh/");
    expect(() => safeUrl("not a url")).toThrow(/valid URL/);
    expect(() => safeUrl("ftp://x.example/file")).toThrow(/https/);
    for (const blocked of [
      "http://localhost:3000/",
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://192.168.1.1/",
      "https://172.20.0.1/",
      "http://169.254.169.254/latest/",
      "https://intranet.local/",
    ]) {
      expect(() => safeUrl(blocked)).toThrow(/private or local/);
    }
  });

  it("distills articles to Markdown with resolved links", () => {
    const prose = "A proper SEO audit walks every public route, records status codes, and diffs metadata against the sitemap week over week. ";
    const parsed = htmlToMarkdown(
      `<html><head><title>SEO Guide</title></head><body><nav>Home About</nav><article><h1>Audit</h1><p>${prose.repeat(4)}</p><p>Run <a href="/s/seo">seo-audit</a> then:</p><ul><li>titles</li><li>meta</li></ul><pre><code class="language-bash">npx skills add x/y</code></pre><p><a href="javascript:void(0)">trap</a></p><p>${prose.repeat(3)}</p></article><script>evil()</script></body></html>`,
      "https://www.skills.sh/",
    );
    expect(parsed.usedReader).toBe(true);
    expect(parsed.markdown).toContain("# Audit");
    expect(parsed.markdown).toContain("-   titles");
    expect(parsed.markdown).toContain("```bash");
    expect(parsed.markdown).toContain("[seo-audit](https://www.skills.sh/s/seo)");
    expect(parsed.markdown).not.toContain("evil()");
    expect(parsed.markdown).not.toContain("javascript:void");
  });

  it("detects CDN challenge pages", () => {
    expect(botWallMessage("Just a moment...\nVerification successful.")).toMatch(/challenge/i);
    expect(botWallMessage("# Attention Required! | Cloudflare\nWhy have I been blocked?")).toMatch(/spawn_worker/i);
    expect(botWallMessage("# Claude pricing\n$3 per million input tokens")).toBeNull();
  });

  it("identifies as a browser and guards non-page content", () => {
    expect(BROWSER_USER_AGENT).toContain("Chrome/");
    expect(BROWSER_USER_AGENT).not.toMatch(/kuru/);
    expect(unsupportedMimeMessage("image/png")).toMatch(/Unsupported fetched image/);
    expect(unsupportedMimeMessage("application/zip")).toMatch(/Unsupported fetched file/);
    expect(unsupportedMimeMessage("text/html; charset=utf-8")).toBeNull();
    expect(unsupportedMimeMessage("application/json")).toBeNull();
  });

  it("falls back to full-body Markdown when nothing scores as an article", () => {
    const parsed = htmlToMarkdown(
      `<html><head><title>Board</title></head><body><div><span>seo-audit</span><span>216619 installs</span></div></body></html>`,
      "https://www.skills.sh/",
    );
    expect(parsed.title).toBe("Board");
    expect(parsed.markdown).toContain("seo-audit");
    expect(parsed.markdown).toContain("216619 installs");
  });
});
