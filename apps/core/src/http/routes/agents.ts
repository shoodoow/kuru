import { routineCreateInputSchema, subagentCreateSchema } from "@kuru/agent-tools";
import { Router } from "express";
import { measureHealth, recentReflections, reflectAgent, undoReflection } from "../../memory/reflection.js";
import { createProfile } from "../../linux/linux.js";
import { buildInstructions } from "../../prompt/build-instructions.js";
import { RoomCapacityError } from "../../rooms/rooms.js";
import { hireSubagent, listTeam, stopWorker } from "../../rooms/subagents.js";
import { runningWork } from "../../rooms/running-work.js";
import { agentMemoryPage, forgetMemory } from "../../memory/agent-memory-page.js";
import { getAgent, updateAgentFlags } from "../../roster/roster.js";
import {
  createOwnRoutine,
  deleteOwnRoutine,
  listOwnRoutineRuns,
  listOwnRoutines,
  updateOwnRoutine,
} from "../../routines/routines.js";
import { logger, pathParam, queryAccountId, type AppContext, type Guard } from "../context.js";

/**
 * Routes under /agents/:agentId: profile, prompt, routines, team, subagents.
 * Input: the request context and the session guard. Output: the router.
 */
export function agentsRoutes(ctx: AppContext, guard: Guard): Router {
  const agents = Router();
  agents.patch("/:agentId", guard, async (req, res) => {
    const updated = await updateAgentFlags(ctx.db, queryAccountId(req), pathParam(req, "agentId"), req.body);
    if (!updated) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(updated);
  });
  // Health: measured by code; "Fix now" reflects at once; each reflection can be undone.
  const activeReflections = new Set<string>();
  agents.get("/:agentId/health", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    const [health, reflections] = await Promise.all([measureHealth(ctx.db, accountId, agentId), recentReflections(ctx.db, accountId, agentId, 5)]);
    const reflecting = activeReflections.has(`${accountId}:${agentId}`);
    res.json({ health, reflections, reflecting });
  });
  agents.post("/:agentId/reflect", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    const key = `${accountId}:${agentId}`;
    if (activeReflections.has(key)) {
      res.status(409).json({ error: "A reflection is already running for this agent.", status: "running" });
      return;
    }
    activeReflections.add(key);
    try {
      // Asked for by the person: read at least the last 3 days, not only what came after the last run.
      const result = await reflectAgent(ctx.db, accountId, agentId, { dryRun: (req.body ?? {}).dryRun === true, lookBackMs: 3 * 24 * 60 * 60 * 1000 });
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? `The reflection could not run: ${error.message.slice(0, 200)}` : "The reflection could not run." });
    } finally {
      activeReflections.delete(key);
    }
  });
  agents.post("/:agentId/reflections/:reflectionId/undo", guard, async (req, res) => {
    const undone = await undoReflection(ctx.db, queryAccountId(req), pathParam(req, "reflectionId"));
    if (!undone) {
      res.status(404).json({ error: "That reflection was already undone, or is not one that changed anything." });
      return;
    }
    res.json({ undone: true });
  });
  // Memory page: every fact the agent reads, and removing one for good.
  agents.get("/:agentId/memories", guard, async (req, res) => {
    const facts = await agentMemoryPage(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!facts) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(facts);
  });
  agents.delete("/:agentId/memories/:memoryId", guard, async (req, res) => {
    const gone = await forgetMemory(ctx.db, queryAccountId(req), pathParam(req, "agentId"), pathParam(req, "memoryId"));
    if (!gone) {
      res.status(404).json({ error: "That memory is already gone." });
      return;
    }
    res.json(gone);
  });
  // Running now: background jobs and routine runs, read from the rows.
  agents.get("/:agentId/running", guard, async (req, res) => {
    const work = await runningWork(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!work) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(work);
  });
  agents.post("/:agentId/workers/:workerId/stop", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const work = await runningWork(ctx.db, accountId, pathParam(req, "agentId"));
    const workerId = pathParam(req, "workerId");
    // Only a job this agent started can be stopped from its page.
    if (!work?.running.some((job) => job.workerId === workerId)) {
      res.status(404).json({ error: "That job is not running." });
      return;
    }
    res.json(await stopWorker(ctx.db, accountId, workerId));
  });
  agents.get("/:agentId/routines", guard, async (req, res) => {
    res.json(await listOwnRoutines(ctx.db, queryAccountId(req), pathParam(req, "agentId")));
  });
  agents.get("/:agentId/routines/:routineId/runs", guard, async (req, res) => {
    const runs = await listOwnRoutineRuns(
      ctx.db,
      queryAccountId(req),
      pathParam(req, "agentId"),
      pathParam(req, "routineId"),
    );
    if (!runs) {
      res.status(404).json({ error: "Routine not found." });
      return;
    }
    res.json(runs);
  });
  agents.post("/:agentId/routines", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    if (!(await getAgent(ctx.db, accountId, agentId))) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    const raw = (req.body ?? {}) as {
      conversationId?: unknown;
      title?: unknown;
      instructions?: unknown;
      cron?: unknown;
      timezone?: unknown;
    };
    if (typeof raw.conversationId !== "string" || raw.conversationId.length === 0) {
      res.status(400).json({ error: "conversationId is required." });
      return;
    }
    try {
      const data = routineCreateInputSchema.parse({
        title: raw.title,
        instructions: raw.instructions,
        cron: raw.cron,
        timezone: raw.timezone ?? undefined,
      });
      res
        .status(201)
        .json(
          await createOwnRoutine(ctx.db, { accountId, conversationId: raw.conversationId, agentId, ...data }),
        );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid routine." });
    }
  });
  agents.patch("/:agentId/routines/:routineId", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    if (!(await getAgent(ctx.db, accountId, agentId))) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    const raw = (req.body ?? {}) as {
      title?: unknown;
      instructions?: unknown;
      cron?: unknown;
      timezone?: unknown;
      paused?: unknown;
    };
    try {
      const updated = await updateOwnRoutine(ctx.db, accountId, agentId, {
        routineId: pathParam(req, "routineId"),
        title: typeof raw.title === "string" ? raw.title : undefined,
        instructions: typeof raw.instructions === "string" ? raw.instructions : undefined,
        cron: typeof raw.cron === "string" ? raw.cron : undefined,
        timezone: typeof raw.timezone === "string" ? raw.timezone : undefined,
        paused: typeof raw.paused === "boolean" ? raw.paused : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: "Routine not found." });
        return;
      }
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid routine." });
    }
  });
  agents.delete("/:agentId/routines/:routineId", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    if (!(await getAgent(ctx.db, accountId, agentId))) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    try {
      const deleted = await deleteOwnRoutine(ctx.db, accountId, agentId, pathParam(req, "routineId"));
      if (!deleted) {
        res.status(404).json({ error: "Routine not found." });
        return;
      }
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid routine." });
    }
  });
  agents.get("/:agentId/prompt", guard, async (req, res) => {
    const agent = await getAgent(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!agent) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json({
      prompt: buildInstructions({
        name: agent.name,
        role: agent.role,
        personality: agent.personality,
        job: agent.jobDescription,
        kind: agent.kind,
      }),
    });
  });
  agents.get("/:agentId", guard, async (req, res) => {
    const agent = await getAgent(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!agent) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(agent);
  });
  agents.get("/:agentId/team", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    res.json(await listTeam(ctx.db, accountId, agentId));
  });
  agents.post("/:agentId/subagents", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const parentAgentId = pathParam(req, "agentId");
    const data = subagentCreateSchema.parse(req.body);
    const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : null;
    if (!conversationId) {
      res.status(400).json({ error: "conversationId is required to join the room." });
      return;
    }
    try {
      const child = await hireSubagent(ctx.db, {
        accountId,
        conversationId,
        parentAgentId,
        label: data.label,
        role: data.role,
        personality: data.personality,
        jobDescription: data.jobDescription,
        provider: data.provider,
        modelId: data.modelId,
      });
      // Best-effort OS user: the hire itself is the contract (201). If the
      // computer is down, the turn runner lazily provisions the profile on the
      // child's first speak, so we return the child instead of failing and
      // risking a duplicate on client retry.
      try {
        await createProfile(ctx.db, accountId, child.id);
      } catch (error) {
        logger.warn({ err: error, accountId, childId: child.id }, "subagent OS profile deferred to first turn");
      }
      res.status(201).json(child);
    } catch (error) {
      if (error instanceof RoomCapacityError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  return agents;
}
