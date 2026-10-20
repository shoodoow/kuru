import { describe, expect, it } from "vitest";
import { ReadCounter, RESULT_INLINE_CHARS, cutResult, resultText, sourceKeys, writtenPaths } from "./result-guard.js";

const home = "/home/ucba539d570a1427d/work/octessa-leads";

describe("sourceKeys", () => {
  it("sees the same file whether it is read, catted or printed with sed", () => {
    const a = sourceKeys("read", { path: `${home}/send-log.md` });
    const b = sourceKeys("bash", { command: `cd ${home}; cat send-log.md` });
    const c = sourceKeys("bash", { command: `cat ${home}/send-log.md; echo; cat ${home}/resend-notes.md` });
    expect(a).toEqual([`file:${home}/send-log.md`]);
    expect(b).toEqual(a);
    expect(c).toContain(a[0]);
    expect(sourceKeys("bash", { command: `cd ${home}; sed -n '17,60p' batch2-shortlist-2026-10-18.md` })).toEqual([`file:${home}/batch2-shortlist-2026-10-18.md`]);
  });

  it("treats a listing as the same source whatever reason the model gives", () => {
    const one = sourceKeys("resend_list-emails", { context: "Final cross-check", limit: 100, llm_model: "x" });
    const two = sourceKeys("resend_list-emails", { context: "Paging the send log again", limit: 100, llm_model: "y" });
    expect(one).toEqual(two);
    expect(sourceKeys("resend_list-emails", { limit: 100, pageToken: "abc" })).not.toEqual(one);
  });

  it("does not count calls that change things", () => {
    expect(sourceKeys("bash", { command: "curl -s https://example.com > page.html" })).toEqual([]);
    expect(sourceKeys("resend_send-email", { to: "a@b.c" })).toEqual([]);
  });
});

describe("ReadCounter", () => {
  it("runs the first reads, reminds on the third, refuses from the fifth", () => {
    const counter = new ReadCounter();
    const key = [`file:${home}/send-log.md`];
    expect(counter.record(key).action).toBe("run");
    expect(counter.record(key).action).toBe("run");
    expect(counter.record(key).action).toBe("remind");
    expect(counter.record(key).action).toBe("remind");
    expect(counter.record(key)).toMatchObject({ action: "refuse", times: 5 });
  });

  it("lets a file be read again after the worker changed it", () => {
    const counter = new ReadCounter();
    const key = [`file:${home}/send-log.md`];
    for (let i = 0; i < 4; i += 1) counter.record(key);
    counter.changed(writtenPaths("edit", { path: `${home}/send-log.md` }));
    expect(counter.record(key).action).toBe("run");
  });
});

describe("writtenPaths", () => {
  it("finds redirect, tee and sed -i targets", () => {
    expect(writtenPaths("bash", { command: "echo hi > out.md 2>/dev/null; sort a | tee -a log.txt; sed -i 's/a/b/' notes.md" })).toEqual(["out.md", "log.txt", "notes.md"]);
  });
});

describe("resultText", () => {
  it("never treats a picture as text, so it is not cut into image bytes", () => {
    const jpeg = "/9j/".padEnd(120_000, "A");
    expect(resultText({ path: "/home/u/.cache/kuru/page.png", jpegBase64: jpeg })).toBeNull();
    expect(resultText({ path: "/home/u/shot.png", pngBase64: jpeg, width: 1280 })).toBeNull();
    expect(resultText({ rows: ["a"] })).toBe('{"rows":["a"]}');
    expect(resultText("plain")).toBe("plain");
  });
});

describe("cutResult", () => {
  it("keeps the start and end and says where the whole text is", () => {
    const text = `${"a".repeat(RESULT_INLINE_CHARS)}MIDDLE${"z".repeat(RESULT_INLINE_CHARS)}`;
    const cut = cutResult(text, "/home/u/.cache/tool-results/abc.txt");
    expect(cut.length).toBeLessThan(RESULT_INLINE_CHARS);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("zzz")).toBe(true);
    expect(cut).toContain("/home/u/.cache/tool-results/abc.txt");
    expect(cut).not.toContain("MIDDLE");
  });
});

describe("page visits", () => {
  it("counts opening a page in the browser like fetching it, one key per page", () => {
    const a = sourceKeys("browser_navigate", { url: "https://www.upwork.com/jobs/abc/#top" });
    expect(a).toEqual(sourceKeys("web_fetch", { url: "https://www.upwork.com/jobs/abc" }));
  });

  it("forgets a page's visits once the worker acted on it", () => {
    const counter = new ReadCounter();
    const keys = sourceKeys("browser_navigate", { url: "https://www.reddit.com/r/selfhosted/comments/1" });
    counter.record(keys, "browser_navigate");
    counter.record(keys, "browser_navigate");
    expect(counter.record(keys, "browser_navigate").action).toBe("remind");
    counter.actedOnPage();
    expect(counter.record(keys, "browser_navigate").action).toBe("run");
  });
});
