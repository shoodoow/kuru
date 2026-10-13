/**
 * Runs the same small jobs through several models and prints how each did, what it used and what it cost.
 * Why: which cheap model is good enough for an agent cannot be read off a price list or someone else's
 * benchmark. These are the things agents here got wrong: not knowing what they are, not using their own
 * tools, fumbling a website, leaving the person without an answer.
 *
 * Usage:
 *   npx tsx --env-file .env scripts/model-eval.mts <agentId> <provider:modelId[@in,out]> [more models...] [--only=1,2] [--heavy]
 *
 * <agentId> is an existing work agent: its account, key and computer are used. For each model a copy of that
 * agent is made (named "Eval ..."), with its own chat; the copies are left in the account so the chats can be
 * read afterwards. "@in,out" is the price per million tokens, for the cost column, e.g. local:z-ai/glm-5.3-flash@0.15,0.5
 * --heavy adds the video job (several minutes and far more tokens).
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { agents, conversations, delegations, members, messages, runs } from "../src/db/schema.js";
import { exec } from "../src/linux/linux.js";
import { resolveSkillsDir } from "../src/skills/paths.js";
import { runTurn } from "../src/turn/orchestrator.js";

type Row = { body: string; kinds: string[]; at: number };
type Outcome = { replies: Row[]; workers: { task: string; status: string; at: number }[]; profile: string | null; accountId: string };
type Job = { name: string; ask: string; limitMs: number; heavy?: boolean; check: (outcome: Outcome) => Promise<string | null> | string | null };

const said = (outcome: Outcome): string => outcome.replies.map((row) => row.body).join("\n");
const MODEL_NAMES = /\b(gpt|chatgpt|openai|claude|anthropic|gemini|mimo|deepseek|glm|qwen|minimax|llama|large language model)\b/i;

/** Each check returns null when the job was done right, or one line saying what was wrong. */
const JOBS: Job[] = [
  {
    name: "knows what it is",
    ask: "What are you exactly, and what can you do for me? Keep it short.",
    limitMs: 90_000,
    check: (outcome) => {
      const text = said(outcome);
      if (!/kuru/i.test(text)) return "did not say it is a Kuru agent";
      if (MODEL_NAMES.test(text)) return "named a model or called itself a language model";
      const mentioned = [/video|render/i, /browser|website|web page|site/i, /computer|command|script|file/i, /schedul|routine/i, /team|teammate/i].filter((re) => re.test(text)).length;
      return mentioned >= 2 ? null : "named fewer than two real capabilities";
    },
  },
  {
    name: "does a small job itself",
    ask: "What is 3 to the power of 41, exactly? Work it out on your computer, don't estimate.",
    limitMs: 120_000,
    check: (outcome) => {
      if (!said(outcome).replace(/[,\s]/g, "").includes("36472996377170786403")) return "wrong or missing number";
      return outcome.workers.length === 0 ? null : "started a worker for a one-line command";
    },
  },
  {
    name: "writes a file",
    ask: "Save a file called eval-note.txt in your home folder containing exactly this line: kuru eval ok",
    limitMs: 180_000,
    check: async (outcome) => {
      if (!outcome.profile) return "the agent has no computer user";
      const file = await exec(outcome.accountId, ["cat", `/home/${outcome.profile}/eval-note.txt`], outcome.profile).catch(() => null);
      return file?.stdout.trim() === "kuru eval ok" ? null : `file is missing or wrong: "${(file?.stdout ?? "").trim().slice(0, 60)}"`;
    },
  },
  {
    name: "reads a live page",
    ask: "Open https://example.com in your browser and tell me the exact text of the main heading on the page.",
    limitMs: 180_000,
    check: (outcome) => (/example domain/i.test(said(outcome)) ? null : "did not report the heading"),
  },
  {
    name: "answers before working",
    ask: "Look up what the current LTS version of Node.js is and when its support ends.",
    limitMs: 240_000,
    check: (outcome) => {
      if (outcome.replies.length === 0) return "no reply at all";
      const first = outcome.replies[0]!;
      // A first message within a few seconds is the short "on it"; a lone late one means the person waited in silence.
      if (outcome.replies.length === 1 && first.at > 25_000) return `one reply only, after ${Math.round(first.at / 1000)} s of silence`;
      return /\b(2[0-9])\b/.test(said(outcome)) ? null : "no version number in the answer";
    },
  },
  {
    name: "uses a website like a person",
    ask: 'Go to https://httpbin.org/forms/post, put "Kuru Test" in the customer name, choose the Large pizza size, submit the order, and tell me what the site shows back for custname and size.',
    limitMs: 600_000,
    check: (outcome) => {
      const text = said(outcome);
      if (!/kuru test/i.test(text)) return "the submitted name did not come back";
      return /large/i.test(text) ? null : "the size did not come back as large";
    },
  },
  {
    name: "makes a video with the skill",
    heavy: true,
    ask: 'Make me a 6 second vertical kinetic-type video that says "HELLO KURU" on a black background and send it to me.',
    limitMs: 1_500_000,
    check: (outcome) => {
      if (outcome.workers.length === 0) return "no worker was started";
      if (outcome.workers.length > 4) return `${outcome.workers.length} workers for one video`;
      return outcome.replies.some((row) => row.kinds.includes("file")) ? null : "no file was sent";
    },
  },
];

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const [agentId, ...models] = args.filter((arg) => !arg.startsWith("--"));
if (!agentId || models.length === 0) throw new Error("Usage: model-eval.mts <agentId> <provider:modelId[@in,out]>... [--only=1,2] [--heavy]");
const only = flags.find((flag) => flag.startsWith("--only="))?.slice(7).split(",").map(Number);
const heavy = flags.includes("--heavy");
const jobs = JOBS.filter((job, index) => (only ? only.includes(index + 1) : heavy || !job.heavy));

const db = getDb(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/kuru_database");
const [source] = await db.select().from(agents).where(eq(agents.id, agentId));
if (!source) throw new Error("Agent not found.");
const skillsRoot = process.env.SKILLS_DIR ?? resolveSkillsDir();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until no turn and no worker is running in the room. */
async function settle(roomId: string, limitMs: number): Promise<boolean> {
  const started = Date.now();
  let quiet = 0;
  while (Date.now() - started < limitMs) {
    await sleep(2000);
    const busyRuns = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.conversationId, roomId), eq(runs.status, "running")));
    const busyWorkers = await db.select({ id: delegations.id }).from(delegations).where(and(eq(delegations.conversationId, roomId), eq(delegations.status, "running")));
    quiet = busyRuns.length + busyWorkers.length === 0 ? quiet + 1 : 0;
    if (quiet >= 4) return true;
  }
  return false;
}

type Line = { model: string; job: string; ok: boolean; why: string; seconds: number; tokensIn: number; tokensOut: number; cost: number | null };
const lines: Line[] = [];

for (const spec of models) {
  const [id, price] = spec.split("@");
  const split = id!.indexOf(":");
  const provider = id!.slice(0, split);
  const modelId = id!.slice(split + 1);
  const [priceIn, priceOut] = (price ?? "").split(",").map(Number);
  const [agent] = await db
    .insert(agents)
    .values({
      accountId: source.accountId,
      // No model name in the agent's name: an agent that says its own name must not look like it named its model.
      name: `Eval-${Math.random().toString(36).slice(2, 8)}`,
      label: "Eval",
      role: source.role,
      personality: source.personality,
      jobDescription: source.jobDescription,
      provider,
      modelId,
    })
    .returning();
  console.log(`\n== ${provider}:${modelId} (agent ${agent!.id})`);
  for (const job of jobs) {
    // A room per job: one job's chat must not help or confuse the next.
    const [room] = await db
      .insert(conversations)
      .values({ accountId: agent!.accountId, kind: "direct", ownerAgentId: agent!.id, title: `eval: ${job.name}` })
      .returning();
    await db.insert(members).values({ accountId: agent!.accountId, conversationId: room!.id, agentId: agent!.id });
    const started = Date.now();
    let why: string | null = null;
    try {
      await runTurn(db, agent!.accountId, room!.id, job.ask, undefined, skillsRoot);
      if (!(await settle(room!.id, job.limitMs))) why = "did not finish in time";
    } catch (error) {
      why = `the turn failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const posted = await db.select().from(messages).where(eq(messages.conversationId, room!.id)).orderBy(messages.createdAt);
    const replies = posted
      .filter((row) => row.agentId)
      .map((row) => ({
        body: row.body,
        kinds: Array.isArray(row.payload) ? (row.payload as { kind: string }[]).map((block) => block.kind) : [],
        at: row.createdAt.getTime() - started,
      }));
    const started_workers = await db.select().from(delegations).where(eq(delegations.conversationId, room!.id)).orderBy(delegations.createdAt);
    const [fresh] = await db.select({ profile: agents.linuxProfile }).from(agents).where(eq(agents.id, agent!.id));
    const outcome: Outcome = {
      replies,
      workers: started_workers.map((row) => ({ task: row.task, status: row.status, at: (row.createdAt?.getTime() ?? started) - started })),
      profile: fresh?.profile ?? null,
      accountId: agent!.accountId,
    };
    why ??= await job.check(outcome);
    const turns = await db.select().from(runs).where(inArray(runs.conversationId, [room!.id]));
    const tokensIn = [...turns, ...started_workers].reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
    const tokensOut = [...turns, ...started_workers].reduce((sum, row) => sum + (row.outputTokens ?? 0), 0);
    const cost = priceIn >= 0 && priceOut >= 0 ? (tokensIn * priceIn + tokensOut * priceOut) / 1_000_000 : null;
    lines.push({ model: modelId, job: job.name, ok: why === null, why: why ?? "", seconds, tokensIn, tokensOut, cost });
    console.log(`${why === null ? "PASS" : "FAIL"}  ${job.name}  ${seconds}s  ${tokensIn}/${tokensOut} tokens${why ? `  — ${why}` : ""}`);
    if (why) console.log(`      said: ${said(outcome).replace(/\s+/g, " ").slice(0, 260) || "(nothing)"}`);
  }
  // Each test agent has its own desktop and browser on the account's computer. Left open, six of them fill its
  // memory, the last browsers crash and restart in a loop, and the later models are tested on a starved machine.
  const [done] = await db.select({ profile: agents.linuxProfile }).from(agents).where(eq(agents.id, agent!.id));
  if (done?.profile) await exec(agent!.accountId, ["sh", "-c", 'pkill -9 -u "$1"; true', "sh", done.profile]).catch(() => undefined);
}

console.log("\n== Summary");
console.log("model".padEnd(34), "passed".padEnd(8), "time".padEnd(8), "tokens in/out".padEnd(22), "cost");
for (const model of [...new Set(lines.map((line) => line.model))]) {
  const mine = lines.filter((line) => line.model === model);
  const cost = mine.every((line) => line.cost !== null) ? `$${mine.reduce((sum, line) => sum + (line.cost ?? 0), 0).toFixed(4)}` : "-";
  console.log(
    model.slice(0, 33).padEnd(34),
    `${mine.filter((line) => line.ok).length}/${mine.length}`.padEnd(8),
    `${mine.reduce((sum, line) => sum + line.seconds, 0)}s`.padEnd(8),
    `${mine.reduce((sum, line) => sum + line.tokensIn, 0)}/${mine.reduce((sum, line) => sum + line.tokensOut, 0)}`.padEnd(22),
    cost,
  );
  for (const line of mine.filter((row) => !row.ok)) console.log(`   failed: ${line.job} — ${line.why}`);
}
await db.$client.end();
process.exit(0);
