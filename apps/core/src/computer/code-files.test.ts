import { describe, expect, it } from "vitest";
import { applyEdits, applyPatchChunks, changedSnippet, pageOfFile, parsePatch } from "./code-files.js";

const numbered = (count: number): string => `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

describe("pageOfFile", () => {
  it("numbers every line and shows a short file whole", () => {
    expect(pageOfFile("a\nb\n")).toBe("1: a\n2: b");
  });

  it("stops at the line limit and says where to read on", () => {
    const page = pageOfFile(numbered(10), { offset: 3, limit: 4 });
    expect(page).toContain("3: line 3\n4: line 4\n5: line 5\n6: line 6");
    expect(page).not.toContain("7: line 7");
    expect(page).toContain("[Lines 3-6 of 10. Read on with offset: 7.]");
  });

  it("stops at the character limit on a whole line", () => {
    const page = pageOfFile(numbered(1_000), { maxChars: 100 });
    expect(page.split("\n").filter((line) => /^\d+: /.test(line)).every((line) => /^\d+: line \d+$/.test(line))).toBe(true);
    expect(page).toMatch(/Read on with offset: \d+\.\]$/);
  });

  it("cuts one very long line instead of returning it whole", () => {
    expect(pageOfFile(`${"x".repeat(5_000)}\n`)).toContain("line cut at 2000 characters");
  });

  it("answers plainly past the end and for an empty file", () => {
    expect(pageOfFile("a\n", { offset: 5 })).toBe("The file has 1 lines; there is nothing from line 5.");
    expect(pageOfFile("")).toBe("(empty file)");
  });
});

describe("applyEdits", () => {
  const source = "import { drawGarden } from './machine.js';\nfunction render(t) {\n  drawGarden(t);\n  stamp(t);\n}\n";

  it("replaces exact text that occurs once", () => {
    const done = applyEdits(source, [{ oldString: "  drawGarden(t);", newString: "  drawWalk(t);" }]);
    expect(done.content).toContain("  drawWalk(t);\n  stamp(t);");
    expect(done.replacements).toBe(1);
    expect(done.changed).toEqual([{ from: 3, to: 3 }]);
  });

  it("refuses text that occurs more than once unless replaceAll is set", () => {
    expect(() => applyEdits(source, [{ oldString: "drawGarden", newString: "drawWalk" }])).toThrow(/found 2 times \(lines 1, 3\)/);
    const all = applyEdits(source, [{ oldString: "drawGarden", newString: "drawWalk", replaceAll: true }]);
    expect(all.content).not.toContain("drawGarden");
    expect(all.replacements).toBe(2);
  });

  it("finds text written with typographic quotes or dashes, and lines that differ only in trailing spaces", () => {
    const quoted = applyEdits("say('hi — there');\n", [{ oldString: "say(‘hi - there’);", newString: "say('bye');" }]);
    expect(quoted.content).toBe("say('bye');\n");
    const spaced = applyEdits("a = 1;   \nb = 2;\n", [{ oldString: "a = 1;\nb = 2;", newString: "a = 3;\nb = 4;" }]);
    expect(spaced.content).toBe("a = 3;\nb = 4;\n");
  });

  it("applies several edits in order, all or none", () => {
    const done = applyEdits(source, [
      { oldString: "import { drawGarden }", newString: "import { drawWalk }" },
      { oldString: "  drawGarden(t);\n  stamp(t);", newString: "  drawWalk(t);" },
    ]);
    expect(done.content).toBe("import { drawWalk } from './machine.js';\nfunction render(t) {\n  drawWalk(t);\n}\n");
    expect(() => applyEdits(source, [{ oldString: "stamp(t)", newString: "x" }, { oldString: "missing", newString: "y" }])).toThrow(/Edit 2: oldString was not found/);
  });

  it("keeps Windows line endings", () => {
    expect(applyEdits("a\r\nb\r\n", [{ oldString: "a\nb", newString: "c\nd" }]).content).toBe("c\r\nd\r\n");
  });

  it("says what is wrong with an empty or unchanged edit", () => {
    expect(() => applyEdits(source, [{ oldString: "", newString: "x" }])).toThrow(/oldString is empty/);
    expect(() => applyEdits(source, [{ oldString: "stamp", newString: "stamp" }])).toThrow(/the same/);
  });
});

describe("changedSnippet", () => {
  it("shows the changed lines with a few around them, numbered", () => {
    const content = numbered(20);
    const snippet = changedSnippet(content, [{ from: 10, to: 10 }]);
    expect(snippet.split("\n")[0]).toBe("7: line 7");
    expect(snippet.split("\n").at(-1)).toBe("13: line 13");
  });

  it("joins changes that are close together", () => {
    expect(changedSnippet(numbered(30), [{ from: 5, to: 5 }, { from: 8, to: 8 }])).not.toContain("...");
    expect(changedSnippet(numbered(30), [{ from: 5, to: 5 }, { from: 25, to: 25 }])).toContain("...");
  });
});

describe("patches", () => {
  it("reads add, update with a rename, and delete", () => {
    const hunks = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: /tmp/new.js",
        "+export const a = 1;",
        "*** Update File: /tmp/app.js",
        "*** Move to: /tmp/main.js",
        "@@ function render(t) {",
        "-  drawGarden(t);",
        "+  drawWalk(t);",
        "*** Delete File: /tmp/old.js",
        "*** End Patch",
      ].join("\n"),
    );
    expect(hunks.map((hunk) => hunk.type)).toEqual(["add", "update", "delete"]);
    expect(hunks[0]).toEqual({ type: "add", path: "/tmp/new.js", contents: "export const a = 1;\n" });
    expect(hunks[1]).toMatchObject({ path: "/tmp/app.js", movePath: "/tmp/main.js" });
  });

  it("names the line that is wrong", () => {
    expect(() => parsePatch("*** Add File: x\n+a")).toThrow(/first line/);
    expect(() => parsePatch("*** Begin Patch\n*** Frobnicate: x\n*** End Patch")).toThrow(/line 2/);
    expect(() => parsePatch("*** Begin Patch\n*** Update File: /tmp/a\n~oops\n*** End Patch")).toThrow(/line 3/);
  });

  it("changes the lines after the @@ context, keeping the rest", () => {
    const [hunk] = parsePatch(
      ["*** Begin Patch", "*** Update File: /tmp/a.js", "@@ function two() {", " x();", "-y();", "+z();", "*** End Patch"].join("\n"),
    );
    if (hunk?.type !== "update") throw new Error("expected an update");
    const before = "function one() {\nx();\ny();\n}\nfunction two() {\nx();\ny();\n}\n";
    expect(applyPatchChunks("/tmp/a.js", hunk.chunks, before)).toBe("function one() {\nx();\ny();\n}\nfunction two() {\nx();\nz();\n}\n");
  });

  it("fails without changing anything when the lines are not in the file", () => {
    const [hunk] = parsePatch(["*** Begin Patch", "*** Update File: /tmp/a.js", "-missing();", "+found();", "*** End Patch"].join("\n"));
    if (hunk?.type !== "update") throw new Error("expected an update");
    expect(() => applyPatchChunks("/tmp/a.js", hunk.chunks, "a();\n")).toThrow(/not found in \/tmp\/a.js/);
  });

  it("accepts a patch wrapped in a heredoc", () => {
    expect(parsePatch("cat <<'EOF'\n*** Begin Patch\n*** Delete File: /tmp/a\n*** End Patch\nEOF")).toEqual([{ type: "delete", path: "/tmp/a" }]);
  });
});

describe("fileToolTip", () => {
  it("points a worker at read once, and at edit once, then stays quiet", async () => {
    const { fileToolTip } = await import("./linux-tool-executes.js");
    const given = new Set<string>();
    expect(fileToolTip("cd ~/kinetic && sed -n 1,200p reel/reel.js", given)).toMatch(/`read` shows a whole file/);
    expect(fileToolTip("cat reel/cues.js", given)).toBeNull();
    expect(fileToolTip("cd ~/kinetic && sed -i 's/a/b/' reel/reel.js", given)).toMatch(/`edit` changes exact text/);
    expect(fileToolTip("sed -i 's/c/d/' x.js", given)).toBeNull();
    expect(fileToolTip("node render.mjs --stills=2", new Set())).toBeNull();
    expect(fileToolTip("ffmpeg -i vo/voice.wav -af volumedetect -f null -", new Set())).toBeNull();
  });
});
