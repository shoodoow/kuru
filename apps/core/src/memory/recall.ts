/**
 * Recall over durable memory: the few lines of a years-long history that
 * matter right now.
 * Why: a long thread accumulates thousands of folded summary items and facts,
 * far more than fits in a prompt. Each turn retrieves a handful instead.
 * Full-text search (search.ts) always runs, so recall works for every account;
 * when an embedding key is configured, vector similarity (pgvector) votes
 * alongside it. With no key the embedding columns simply stay null.
 * DB: reads/writes summary_items.embedding and memories.embedding.
 */
import { config } from "../config.js";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany, type EmbeddingModel } from "ai";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { members, memories, summaryItems } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { isOpenAiCompatibleProvider } from "../model/get-model.js";
import { RECALL_K } from "../turn/constants.js";
import { hitLine, mergeRanked, searchFacts, searchSummaries, searchTerms, type MemoryHit } from "./search.js";
import { noted } from "../log/logger.js";

type Db = ReturnType<typeof getDb>;

const EMBED_MODEL = "text-embedding-3-small";
const BACKLOG_LIMIT = 64;
/** Cosine distance ceiling (0 = identical, 2 = opposite). Drops weak matches. */
const MAX_DISTANCE = 0.6;

/**
 * Resolves an embedding model from the account's keys, or null when none can
 * embed. The key is looked up under EMBEDDING_PROVIDER (default `openai`), so
 * an account whose only key is an OpenAI-compatible `local` endpoint that
 * serves embeddings can use it. EMBEDDING_MODEL must produce 1536-dimension
 * vectors (the column size). With no usable key this stays dormant and recall
 * falls back to full-text search, so chat never depends on it.
 */
async function accountEmbedder(db: Db, accountId: string): Promise<EmbeddingModel | null> {
  const provider = config.embeddingProvider();
  if (!isOpenAiCompatibleProvider(provider)) return null;
  const credential = await keyFor(db, accountId, provider).catch(() => null);
  if (!credential) return null;
  const key = credential.apiKey.trim();
  if (!key) return null;
  const base = credential.baseUrl?.trim();
  const model = config.embeddingModel() ?? EMBED_MODEL;
  return createOpenAI({ apiKey: key, ...(base ? { baseURL: base } : {}) }).textEmbeddingModel(model);
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Embeds any summary items (for one room) and account facts that are missing a
 * vector. Called after a fold so new durable memory becomes recall-reachable.
 */
export async function embedSummaryBacklog(db: Db, accountId: string, conversationId: string): Promise<void> {
  const model = await accountEmbedder(db, accountId);
  if (!model) return;
  const pendingSummaries = await db
    .select({ id: summaryItems.id, body: summaryItems.body })
    .from(summaryItems)
    .where(and(eq(summaryItems.accountId, accountId), eq(summaryItems.conversationId, conversationId), isNull(summaryItems.embedding)))
    .limit(BACKLOG_LIMIT);
  const pendingFacts = await db
    .select({ id: memories.id, body: memories.body })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), isNull(memories.embedding)))
    .limit(BACKLOG_LIMIT);
  await embedRows(db, model, summaryItems, pendingSummaries);
  await embedRows(db, model, memories, pendingFacts);
}

async function embedRows(
  db: Db,
  model: EmbeddingModel,
  table: typeof summaryItems | typeof memories,
  rows: { id: string; body: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const { embeddings } = await embedMany({ model, values: rows.map((row) => row.body) });
  for (let i = 0; i < rows.length; i++) {
    const vector = embeddings[i];
    if (!vector) continue;
    await db.update(table).set({ embedding: vector }).where(eq(table.id, rows[i]!.id)).catch(noted("Saving an embedding"));
  }
}

/**
 * Cosine distance under which two memory lines likely mean the same thing.
 * Paraphrases of one rule sit around 0.05-0.12; related but different rules
 * (same topic, another number or case) sit further out. Being close is only a
 * candidate: the reflection model decides whether to merge.
 */
export const ALIKE_DISTANCE = 0.13;

/** Fills missing vectors for these memory rows; returns the embedder, or null when there is none. */
async function vectorsFor(db: Db, accountId: string, ids: string[]): Promise<EmbeddingModel | null> {
  const model = await accountEmbedder(db, accountId);
  if (!model || ids.length === 0) return model;
  const missing = await db
    .select({ id: memories.id, body: memories.body })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), inArray(memories.id, ids), isNull(memories.embedding)));
  await embedRows(db, model, memories, missing).catch(noted("Embedding memory lines"));
  return model;
}

/**
 * Pairs among these memory rows that mean nearly the same, by embedding, or
 * null when the account has no embedder (then nothing is guessed from words).
 */
export async function alikePairs(db: Db, accountId: string, ids: string[]): Promise<[string, string][] | null> {
  if (!(await vectorsFor(db, accountId, ids))) return null;
  if (ids.length < 2) return [];
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    select a.id as a, b.id as b from memories a join memories b on a.id < b.id
    where a.id in (${list}) and b.id in (${list})
      and a.embedding is not null and b.embedding is not null
      and (a.embedding <=> b.embedding) < ${ALIKE_DISTANCE}
  `)) as unknown as { a: string; b: string }[];
  return rows.map((row) => [row.a, row.b]);
}

/**
 * For each text, the closest of these memory rows and how far it is, or null
 * when the account has no embedder.
 */
export async function closestRows(
  db: Db,
  accountId: string,
  texts: string[],
  ids: string[],
): Promise<({ id: string; distance: number } | null)[] | null> {
  const model = await vectorsFor(db, accountId, ids);
  if (!model) return null;
  if (texts.length === 0 || ids.length === 0) return texts.map(() => null);
  const { embeddings } = await embedMany({ model, values: texts }).catch(() => ({ embeddings: null as number[][] | null }));
  if (!embeddings) return null;
  const found: ({ id: string; distance: number } | null)[] = [];
  for (const vector of embeddings) {
    const [row] = await db
      .select({ id: memories.id, distance: sql<number>`${memories.embedding} <=> ${toVectorLiteral(vector)}::vector` })
      .from(memories)
      .where(and(eq(memories.accountId, accountId), inArray(memories.id, ids), sql`${memories.embedding} is not null`))
      .orderBy(sql`${memories.embedding} <=> ${toVectorLiteral(vector)}::vector`)
      .limit(1);
    found.push(row ? { id: row.id, distance: Number(row.distance) } : null);
  }
  return found;
}

/** Nearest facts and summary lines by embedding, or [] when no embedder is configured. */
async function vectorHits(
  db: Db,
  input: { accountId: string; agentId: string; query: string; limit: number },
): Promise<MemoryHit[][]> {
  const model = await accountEmbedder(db, input.accountId);
  if (!model) return [];
  const { embedding } = await embed({ model, value: input.query }).catch(() => ({ embedding: null as number[] | null }));
  if (!embedding) return [];
  const literal = toVectorLiteral(embedding);
  const summaryHits = await db
    .select({
      id: summaryItems.id,
      key: summaryItems.key,
      body: summaryItems.body,
      messageId: summaryItems.messageId,
      at: summaryItems.createdAt,
      distance: sql<number>`${summaryItems.embedding} <=> ${literal}::vector`,
    })
    .from(summaryItems)
    .innerJoin(
      members,
      and(
        eq(members.conversationId, summaryItems.conversationId),
        eq(members.accountId, summaryItems.accountId),
        eq(members.agentId, input.agentId),
      ),
    )
    .where(and(eq(summaryItems.accountId, input.accountId), sql`${summaryItems.embedding} is not null`))
    .orderBy(sql`${summaryItems.embedding} <=> ${literal}::vector`)
    .limit(input.limit);
  const factHits = await db
    .select({
      id: memories.id,
      subject: memories.subject,
      body: memories.body,
      messageId: memories.messageId,
      at: memories.validFrom,
      distance: sql<number>`${memories.embedding} <=> ${literal}::vector`,
    })
    .from(memories)
    .where(
      and(
        eq(memories.accountId, input.accountId),
        isNull(memories.supersededBy),
        sql`${memories.kind} <> 'profile'`,
        sql`(${memories.scope} = 'user' or (${memories.scope} = 'agent' and ${memories.agentId} = ${input.agentId}))`,
        sql`${memories.embedding} is not null`,
      ),
    )
    .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
    .limit(input.limit);
  return [
    factHits
      .filter((hit) => hit.distance <= MAX_DISTANCE)
      .map((hit) => ({
        source: "fact" as const,
        id: hit.id,
        body: hit.subject ? `${hit.subject}: ${hit.body}` : hit.body,
        messageId: hit.messageId,
        at: hit.at,
      })),
    summaryHits
      .filter((hit) => hit.distance <= MAX_DISTANCE)
      .map((hit) => ({
        source: "summary" as const,
        id: hit.id,
        body: `${hit.key}: ${hit.body}`,
        messageId: hit.messageId,
        at: hit.at,
      })),
  ];
}

/**
 * Pulls the durable memory most relevant to the current moment.
 * Why: years of history cannot ride in the prompt, so each turn retrieves a
 * few lines instead. Full-text search always runs; embeddings join in when a
 * key exists. Replaced facts are never returned.
 * Input: db, ids, the query text (the latest exchange), and k.
 * Output: up to k hits (current facts + folded summaries from rooms this
 * agent belongs to), best first.
 */
export async function recallHits(
  db: Db,
  input: { accountId: string; agentId: string; conversationId: string; query: string; k?: number },
): Promise<MemoryHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  const k = input.k ?? RECALL_K;
  const terms = searchTerms(query);
  const scope = { accountId: input.accountId, agentId: input.agentId };
  const [facts, summaries, vectors] = await Promise.all([
    searchFacts(db, { ...scope, terms, limit: k }).catch(() => []),
    searchSummaries(db, { ...scope, terms, limit: k }).catch(() => []),
    vectorHits(db, { ...scope, query: query.slice(0, 2_000), limit: k }).catch(() => [] as MemoryHit[][]),
  ]);
  return mergeRanked([...vectors, facts, summaries], k);
}

/** Same as recallHits, rendered as dated prompt lines. */
export async function recallRelevant(
  db: Db,
  input: { accountId: string; agentId: string; conversationId: string; query: string; k?: number },
): Promise<string[]> {
  return (await recallHits(db, input)).map((hit) => hitLine(hit));
}
