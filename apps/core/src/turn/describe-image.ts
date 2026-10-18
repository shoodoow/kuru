/**
 * Lets a model that reads only text "see" a picture: another model, one that
 * can see, describes it in words.
 * Why: workers run on the account's cheap background model, often text only,
 * yet their jobs say "render it, then look at the frames". Sent to such a
 * model, a picture made the provider refuse the request and the job failed.
 * DB: reads agents (candidate models) and provider keys.
 */
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { modelCapabilities } from "../model/capabilities.js";

type Db = ReturnType<typeof getDb>;

export type ImageToDescribe = { path: string; base64: string; mediaType: string };
export type DescribeUsage = { inputTokens: number; outputTokens: number };
export type ImageDescriber = (image: ImageToDescribe) => Promise<string>;

/** Longest description; enough for every line of text in a frame and what is wrong with it. */
const DESCRIPTION_TOKENS = 900;

const INSTRUCTION = [
  "You are the eyes of a colleague who cannot see this image. Describe it so they can check their work without seeing it.",
  "Copy every piece of visible text exactly, in reading order.",
  "Say what objects, shapes and colours are where (top, middle, bottom; left, right).",
  "Point out problems plainly: text cut off or overflowing, objects cut off at an edge, blank or black areas, broken glyphs, overlapping elements, anything that looks unfinished.",
  "No opinions about style unless something is clearly broken. Be concise.",
].join(" ");

/**
 * Builds a describer for a worker, or null when no model of the account can see.
 * Input: the account and the models to try, best first (the agent the worker
 * reports to comes first). Output: a function from picture to words, which
 * also reports what each look cost through `onUsage`.
 */
export async function imageDescriber(
  db: Db,
  accountId: string,
  preferred: { provider: string; modelId: string }[],
  onUsage?: (usage: DescribeUsage) => void,
): Promise<ImageDescriber | null> {
  const others = await db
    .select({ provider: agents.provider, modelId: agents.modelId })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), eq(agents.hidden, false)))
    .catch(() => [] as { provider: string; modelId: string }[]);
  const seen = new Set<string>();
  for (const candidate of [...preferred, ...others]) {
    const id = `${candidate.provider}:${candidate.modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // Only a model known to see: guessing wrong here is the failure this exists to avoid.
    if ((await modelCapabilities(candidate.provider, candidate.modelId)).vision !== true) continue;
    const credential = await keyFor(db, accountId, candidate.provider).catch(() => null);
    if (!credential) continue;
    const model = getModel(candidate.provider, candidate.modelId, credential.apiKey, credential.baseUrl);
    return async (image) => {
      const result = await generateText({
        model,
        maxOutputTokens: DESCRIPTION_TOKENS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: INSTRUCTION },
              { type: "file", mediaType: image.mediaType, data: image.base64 },
            ],
          },
        ],
      });
      onUsage?.({ inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 });
      return `Image ${image.path}, described by ${candidate.modelId} because your model cannot see pictures:\n${result.text.trim()}`;
    };
  }
  return null;
}

/** What a worker is told when it opened a picture and nothing can look at it for it. */
export function cannotSeeNote(path: string): string {
  return `Image ${path} exists, but your model cannot see pictures and no model on this account that can was available. Check it another way (ffprobe, file size, pixel statistics with ffmpeg or python), or say in your report that it was not looked at.`;
}
