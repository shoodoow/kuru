/**
 * Pure text work behind the code tools: a file shown a page at a time with
 * line numbers, an exact-text edit, and a patch over several files.
 * Why: workers had only cat, sed and a whole-file write. A 368-line scene file
 * did not fit in one read (cut at 8,000 characters), so a worker read it in
 * slices with sed and awk and changed it with `sed -i`, re-reading after every
 * change to check it: 435 steps and about 29 million tokens for one edit job.
 * The matching rules follow opencode (MIT): exact text first, then the same
 * text with typographic quotes and dashes made plain, then line by line
 * ignoring trailing spaces. DB: none.
 */

/** Most lines one read returns. */
export const READ_PAGE_LINES = 2_000;
/** Most characters one read returns; a page stops at the line that would pass it. */
export const READ_PAGE_CHARS = 50_000;
/** A longer line is shown cut, with a note. */
const READ_LINE_CHARS = 2_000;
/** Lines shown on each side of a change in an edit's answer. */
const EDIT_CONTEXT_LINES = 3;
/** Most lines an edit's answer shows in all. */
const EDIT_SNIPPET_LINES = 60;

/**
 * One page of a text file, each line prefixed with its number.
 * Input: the file text, the first line to show (1-based) and how many lines, and the most characters to return.
 * Output: the page, ending with a note on how to read on when the file continues.
 */
export function pageOfFile(text: string, options: { offset?: number; limit?: number; maxChars?: number } = {}): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const total = lines.length;
  if (total === 0) return "(empty file)";
  const start = Math.max(1, Math.floor(options.offset ?? 1));
  if (start > total) return `The file has ${total} lines; there is nothing from line ${start}.`;
  const limit = Math.min(READ_PAGE_LINES, Math.max(1, Math.floor(options.limit ?? READ_PAGE_LINES)));
  const maxChars = options.maxChars ?? READ_PAGE_CHARS;
  const out: string[] = [];
  let used = 0;
  let line = start;
  for (; line <= total && line < start + limit; line += 1) {
    const raw = lines[line - 1]!;
    const shown = raw.length > READ_LINE_CHARS ? `${raw.slice(0, READ_LINE_CHARS)}... (line cut at ${READ_LINE_CHARS} characters)` : raw;
    const entry = `${line}: ${shown}`;
    if (out.length > 0 && used + entry.length + 1 > maxChars) break;
    out.push(entry);
    used += entry.length + 1;
  }
  const last = line - 1;
  if (last < total) out.push(`\n[Lines ${start}-${last} of ${total}. Read on with offset: ${last + 1}.]`);
  return out.join("\n");
}

/** One replacement in an edit. */
export type TextEdit = { oldString: string; newString: string; replaceAll?: boolean };

type Span = { start: number; end: number };

const plainChars = (value: string): string =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");

function occurrences(content: string, search: string): Span[] {
  const found: Span[] = [];
  let at = content.indexOf(search);
  while (at !== -1) {
    found.push({ start: at, end: at + search.length });
    at = content.indexOf(search, at + search.length);
  }
  return found;
}

/** Whole-line matches of `search`, comparing each line without trailing spaces and with plain characters. */
function lineOccurrences(content: string, search: string): Span[] {
  const wanted = search.replace(/\n$/, "").split("\n").map((line) => plainChars(line.trimEnd()));
  const starts: number[] = [0];
  for (let index = 0; index < content.length; index += 1) if (content[index] === "\n") starts.push(index + 1);
  const lines = content.split("\n");
  const found: Span[] = [];
  for (let first = 0; first + wanted.length <= lines.length; first += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length && same; offset += 1) {
      same = plainChars(lines[first + offset]!.trimEnd()) === wanted[offset];
    }
    if (!same) continue;
    const lastLine = first + wanted.length - 1;
    const end = starts[lastLine]! + lines[lastLine]!.length + (search.endsWith("\n") && lastLine < lines.length - 1 ? 1 : 0);
    if (found.some((span) => span.end > starts[first]!)) continue;
    found.push({ start: starts[first]!, end });
  }
  return found;
}

/** Where `search` stands in `content`: exact first, then with plain characters, then line by line. */
function locate(content: string, search: string): Span[] {
  const exact = occurrences(content, search);
  if (exact.length > 0) return exact;
  // Same length either way, so positions in the plain copy are positions in the file.
  const plain = occurrences(plainChars(content), plainChars(search));
  if (plain.length > 0) return plain;
  return lineOccurrences(content, search);
}

/** Line number (1-based) of a character position. */
function lineAt(content: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position && index < content.length; index += 1) if (content[index] === "\n") line += 1;
  return line;
}

/**
 * Applies edits to a file's text, in order; all of them or none.
 * Input: the text and the edits. Output: the new text, how many places changed,
 * and the changed line ranges in the new text. Throws an error the model can act on.
 */
export function applyEdits(source: string, edits: TextEdit[]): { content: string; replacements: number; changed: { from: number; to: number }[] } {
  if (edits.length === 0) throw new Error("No edit given: pass oldString and newString, or edits.");
  const crlf = source.includes("\r\n");
  let content = crlf ? source.replace(/\r\n/g, "\n") : source;
  let replacements = 0;
  let changed: { from: number; to: number }[] = [];
  for (const [index, edit] of edits.entries()) {
    const which = edits.length > 1 ? `Edit ${index + 1}: ` : "";
    const search = edit.oldString.replace(/\r\n/g, "\n");
    const replacement = edit.newString.replace(/\r\n/g, "\n");
    if (search === "") throw new Error(`${which}oldString is empty. To write a new file use write; to add text, include the line it goes after in oldString.`);
    if (search === replacement) throw new Error(`${which}oldString and newString are the same, so nothing would change.`);
    const spans = locate(content, search);
    if (spans.length === 0) {
      throw new Error(`${which}oldString was not found in the file. Read the part you want to change again and copy it exactly, without the line-number prefixes.`);
    }
    if (spans.length > 1 && !edit.replaceAll) {
      const lines = spans.slice(0, 5).map((span) => lineAt(content, span.start)).join(", ");
      throw new Error(`${which}oldString is found ${spans.length} times (lines ${lines}). Include more of the surrounding lines so it matches once, or set replaceAll.`);
    }
    // Earlier ranges shift by what this edit adds or removes before them.
    const delta = replacement.split("\n").length - search.split("\n").length;
    const spanLines = spans.map((span) => lineAt(content, span.start));
    changed = changed.map((range) => {
      const shift = delta * spanLines.filter((line) => line < range.from).length;
      return { from: range.from + shift, to: range.to + shift };
    });
    let next = "";
    let from = 0;
    let shift = 0;
    for (const span of spans) {
      next += content.slice(from, span.start) + replacement;
      from = span.end;
      const startLine = lineAt(content, span.start) + shift;
      changed.push({ from: startLine, to: startLine + Math.max(0, replacement.split("\n").length - 1) });
      shift += delta;
    }
    content = next + content.slice(from);
    replacements += spans.length;
  }
  return { content: crlf ? content.replace(/\n/g, "\r\n") : content, replacements, changed };
}

/**
 * The changed parts of a file with a few lines around each, numbered like a read.
 * Why: the answer shows the result, so the worker does not read the file again to check the edit.
 */
export function changedSnippet(content: string, changed: { from: number; to: number }[]): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const ranges = changed
    .map((range) => ({ from: Math.max(1, range.from - EDIT_CONTEXT_LINES), to: Math.min(lines.length, range.to + EDIT_CONTEXT_LINES) }))
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  const out: string[] = [];
  let shown = 0;
  for (const range of merged) {
    if (out.length > 0) out.push("...");
    for (let line = range.from; line <= range.to; line += 1) {
      if (shown >= EDIT_SNIPPET_LINES) {
        out.push(`[... more changes; read the file to see them all]`);
        return out.join("\n");
      }
      out.push(`${line}: ${lines[line - 1] ?? ""}`);
      shown += 1;
    }
  }
  return out.join("\n");
}

/** One file operation of a patch. */
export type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

type PatchChunk = { oldLines: string[]; newLines: string[]; changeContext?: string; endOfFile?: boolean };

const isBoundary = (line: string): boolean =>
  line === "*** End Patch" || line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ");

/**
 * Reads a patch in the `*** Begin Patch` format (as in Codex and opencode).
 * Input: the patch text. Output: its file operations. Throws an error naming the line that is wrong.
 */
export function parsePatch(patchText: string): PatchHunk[] {
  const unwrapped = patchText.trim().match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? patchText.trim();
  const lines = unwrapped.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[0]?.trim() !== "*** Begin Patch") throw new Error("The first line of the patch must be '*** Begin Patch'.");
  const end = lines.length - 1;
  if (lines[end]?.trim() !== "*** End Patch" || end === 0) throw new Error("The last line of the patch must be '*** End Patch'.");
  const bad = (index: number, reason: string): Error => new Error(`Patch line ${index + 1}: ${reason}`);
  const hunks: PatchHunk[] = [];
  let index = 1;
  while (index < end) {
    const header = lines[index]!.trim();
    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length).trim();
      const body: string[] = [];
      index += 1;
      while (index < end && !isBoundary(lines[index]!.trim())) {
        if (!lines[index]!.startsWith("+")) throw bad(index, `every line of Add File '${path}' starts with '+'.`);
        body.push(lines[index]!.slice(1));
        index += 1;
      }
      hunks.push({ type: "add", path, contents: body.length > 0 ? `${body.join("\n")}\n` : "" });
      continue;
    }
    if (header.startsWith("*** Delete File: ")) {
      const path = header.slice("*** Delete File: ".length).trim();
      if (index + 1 < end && !isBoundary(lines[index + 1]!.trim())) throw bad(index + 1, `Delete File '${path}' takes no lines after it.`);
      hunks.push({ type: "delete", path });
      index += 1;
      continue;
    }
    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length).trim();
      const headerIndex = index;
      index += 1;
      let movePath: string | undefined;
      if (lines[index]?.trimEnd().startsWith("*** Move to: ")) {
        movePath = lines[index]!.trimEnd().slice("*** Move to: ".length).trim();
        if (!movePath) throw bad(index, `the new name for '${path}' is empty.`);
        index += 1;
      }
      const chunks: PatchChunk[] = [];
      while (index < end) {
        const line = lines[index]!;
        const trimmed = line.trimEnd();
        if (isBoundary(trimmed)) break;
        if (trimmed === "*** End of File") {
          const last = chunks.at(-1);
          if (last) last.endOfFile = true;
          index += 1;
          continue;
        }
        if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
          chunks.push({ oldLines: [], newLines: [], changeContext: trimmed === "@@" ? undefined : trimmed.slice(3) });
          index += 1;
          continue;
        }
        if (chunks.length === 0) chunks.push({ oldLines: [], newLines: [] });
        const chunk = chunks.at(-1)!;
        if (line === "") {
          chunk.oldLines.push("");
          chunk.newLines.push("");
        } else if (line.startsWith(" ")) {
          chunk.oldLines.push(line.slice(1));
          chunk.newLines.push(line.slice(1));
        } else if (line.startsWith("-")) {
          chunk.oldLines.push(line.slice(1));
        } else if (line.startsWith("+")) {
          chunk.newLines.push(line.slice(1));
        } else {
          throw bad(index, `'${line.slice(0, 80)}' — every line of an update starts with ' ' (unchanged), '-' (removed) or '+' (added), or is an '@@' marker.`);
        }
        index += 1;
      }
      const real = chunks.filter((chunk) => chunk.oldLines.length > 0 || chunk.newLines.length > 0);
      if (real.length === 0 && !movePath) throw bad(headerIndex, `Update File '${path}' has no changes.`);
      hunks.push({ type: "update", path, movePath, chunks: real });
      continue;
    }
    throw bad(index, `'${header.slice(0, 80)}' is not a file header. Use '*** Add File: <path>', '*** Delete File: <path>' or '*** Update File: <path>'.`);
  }
  if (hunks.length === 0) throw new Error("The patch changes no files.");
  return hunks;
}

const sameLine = [
  (a: string, b: string) => a === b,
  (a: string, b: string) => a.trimEnd() === b.trimEnd(),
  (a: string, b: string) => a.trim() === b.trim(),
  (a: string, b: string) => plainChars(a.trim()) === plainChars(b.trim()),
];

/** First line at or after `start` where `pattern` matches, trying looser comparisons only when stricter ones fail. */
function seek(lines: string[], pattern: string[], start: number, endOfFile = false): number {
  if (pattern.length === 0) return -1;
  for (const compare of sameLine) {
    if (endOfFile) {
      const at = lines.length - pattern.length;
      if (at >= start && pattern.every((line, offset) => compare(lines[at + offset]!, line))) return at;
      continue;
    }
    for (let at = start; at <= lines.length - pattern.length; at += 1) {
      if (pattern.every((line, offset) => compare(lines[at + offset]!, line))) return at;
    }
  }
  return -1;
}

/**
 * A file's text after one Update File operation.
 * Input: the path (for errors), the operation's chunks and the current text. Output: the new text.
 */
export function applyPatchChunks(path: string, chunks: PatchChunk[], original: string): string {
  const crlf = original.includes("\r\n");
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements: [start: number, remove: number, insert: string[]][] = [];
  let from = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const at = seek(lines, [chunk.changeContext], from);
      if (at === -1) throw new Error(`The '@@ ${chunk.changeContext}' line was not found in ${path}.`);
      from = at + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines]);
      continue;
    }
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let at = seek(lines, oldLines, from, chunk.endOfFile);
    if (at === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      at = seek(lines, oldLines, from, chunk.endOfFile);
    }
    if (at === -1) throw new Error(`These lines were not found in ${path}; read that part of the file again:\n${chunk.oldLines.slice(0, 12).join("\n")}`);
    replacements.push([at, oldLines.length, newLines]);
    from = at + oldLines.length;
  }
  for (const [start, remove, insert] of replacements.sort((a, b) => b[0] - a[0])) lines.splice(start, remove, ...insert);
  const text = `${lines.join("\n")}\n`;
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}
