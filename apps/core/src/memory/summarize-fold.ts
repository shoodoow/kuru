/**
 * The LLM summarizer used when the recent window ages messages out.
 * Why: folding must turn an old slice into a few durable, cited lines plus
 * the facts worth knowing years later, so the thread stays sharp without the
 * whole transcript in context. The model sees numbered, dated lines and the
 * facts memory already holds, and answers in a small line grammar (see
 * prompts/memory.md). A model hiccup falls back to one compressed topics
 * line, so compaction always makes progress and never blocks a turn.
 */
import { generateText } from "ai";
import { memoryKinds, summaryKeys, type MemoryKind } from "../db/schema.js";
import { getModel } from "../model/get-model.js";
import type { FoldFact, FoldItem, FoldOutput, FoldSummarizer, KnownFact, OpenItem, SliceMessage } from "./compaction.js";
import { prompt } from "../prompt/prompts.js";

const KEY_SET = new Set<string>(summaryKeys);
const KIND_SET = new Set<string>(memoryKinds.filter((kind) => kind !== "profile"));
const MAX_ITEM = 500;
const MAX_ITEMS = 8;
/** Facts one fold may save: only what the agent will use later, so memory stays small enough to read whole. */
const MAX_FACTS = 3;
const LINE_BODY_CHARS = 1_500;

export type ModelDeps = { provider: string; modelId: string; apiKey: string; baseUrl: string | null };

/** One numbered, dated transcript line per message: `[3] 2026-10-08 person: …`. */
export function renderSlice(slice: SliceMessage[]): string {
  return slice
    .map((message, index) => {
      const date = message.createdAt ? `${message.createdAt.toISOString().slice(0, 10)} ` : "";
      const who = message.agentId ? "agent" : "person";
      return `[${index + 1}] ${date}${who}: ${message.body.replace(/\s+/g, " ").trim().slice(0, LINE_BODY_CHARS)}`;
    })
    .join("\n");
}

/** Facts already in memory as `M1: subject: body` lines the model can refer to. */
export function renderKnown(known: KnownFact[]): string {
  if (known.length === 0) return "(none yet)";
  return known
    .map((fact, index) => `M${index + 1}: ${fact.subject ? `${fact.subject}: ` : ""}${fact.body.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
}

/** Open summary lines as `O1: body`, so the model can say which the slice settled. */
export function renderOpen(open: OpenItem[]): string {
  if (open.length === 0) return "(none)";
  return open.map((item, index) => `O${index + 1}: ${item.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
}

export function llmFoldSummarizer(deps: ModelDeps): FoldSummarizer {
  return async (slice, known, open = []) => {
    try {
      const result = await generateText({
        model: getModel(deps.provider, deps.modelId, deps.apiKey, deps.baseUrl),
        instructions: [{ role: "system" as const, content: prompt("memory", "fold") }],
        messages: [
          {
            role: "user",
            content: prompt("memory", "fold-user", {
              known: renderKnown(known),
              open: renderOpen(open),
              transcript: renderSlice(slice),
            }),
          },
        ],
      });
      const parsed = parseFold(result.text ?? "", slice, known, open);
      if (parsed.items.length > 0 || (parsed.facts?.length ?? 0) > 0 || (parsed.closed?.length ?? 0) > 0) return parsed;
    } catch {
      // Fall through to the deterministic fallback below.
    }
    return { items: [{ key: "topics", body: fallbackLine(slice), messageId: slice.at(-1)!.id }] };
  };
}

/**
 * Parses the fold grammar.
 *   decisions [4]: Ship the intro at 15 seconds.
 *   fact [7] person | Sara Ahmadi: Head of marketing at Acme.
 *   update M3 [9]: Sara moved to Globex as CMO.
 *   done O2
 * `[n]` is the transcript line the statement came from; a missing or bad
 * number cites the newest message. Lines that fit no rule are ignored.
 */
export function parseFold(text: string, slice: SliceMessage[], known: KnownFact[], open: OpenItem[] = []): FoldOutput {
  const lastId = slice.at(-1)!.id;
  const idAt = (n: string | undefined): string => slice[Number(n) - 1]?.id ?? lastId;
  const items: FoldItem[] = [];
  const facts: FoldFact[] = [];
  const closed: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[-*\s]+/, "").trim();
    if (!line) continue;

    const done = line.match(/^done\s+O(\d+)\b/i);
    if (done) {
      const item = open[Number(done[1]) - 1];
      if (item && !closed.includes(item.id)) closed.push(item.id);
      continue;
    }

    const update = line.match(/^update\s+M(\d+)\s*(?:\[(\d+)\])?\s*:\s*(.+)$/i);
    if (update) {
      const old = known[Number(update[1]) - 1];
      if (old && facts.length < MAX_FACTS) {
        facts.push({
          kind: "fact",
          subject: old.subject,
          body: update[3]!.trim().slice(0, MAX_ITEM),
          messageId: idAt(update[2]),
          replaces: old.id,
        });
      }
      continue;
    }

    const fact = line.match(/^fact\s*(?:\[(\d+)\])?\s*([a-z]+)\s*\|\s*([^:|]*):\s*(.+)$/i);
    if (fact) {
      const kind = fact[2]!.toLowerCase();
      if (facts.length < MAX_FACTS) {
        facts.push({
          kind: (KIND_SET.has(kind) ? kind : "fact") as MemoryKind,
          subject: fact[3]!.trim().slice(0, 120) || null,
          body: fact[4]!.trim().slice(0, MAX_ITEM),
          messageId: idAt(fact[1]),
        });
      }
      continue;
    }

    const item = line.match(/^([a-z]+)\s*(?:\[(\d+)\])?\s*:\s*(.+)$/i);
    if (item && KEY_SET.has(item[1]!.toLowerCase()) && items.length < MAX_ITEMS) {
      items.push({ key: item[1]!.toLowerCase(), body: item[3]!.trim().slice(0, MAX_ITEM), messageId: idAt(item[2]) });
    }
  }
  return { items, facts, closed };
}

function fallbackLine(slice: { agentId: string | null; body: string }[]): string {
  const joined = slice.map((message) => message.body.replace(/\s+/g, " ").trim()).join(" | ");
  return `Earlier ${slice.length} messages: ${joined}`.slice(0, MAX_ITEM);
}

/** Plain text completion for the roll-up and profile passes. Empty string on any failure. */
export function llmWriter(deps: ModelDeps): (system: string, user: string) => Promise<string> {
  return async (system, user) => {
    try {
      const result = await generateText({
        model: getModel(deps.provider, deps.modelId, deps.apiKey, deps.baseUrl),
        instructions: [{ role: "system" as const, content: system }],
        messages: [{ role: "user", content: user }],
      });
      return (result.text ?? "").trim();
    } catch {
      return "";
    }
  };
}
