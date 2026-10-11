import { Router } from "express";
import { approve, reject } from "../../skills/proposals.js";
import { pathParam, queryAccountId, type AppContext, type Guard } from "../context.js";

/**
 * Routes under /proposals/:proposalId: approve or reject what an agent proposed.
 * Input: the request context and the session guard. Output: the router.
 */
export function proposalsRoutes(ctx: AppContext, guard: Guard): Router {
  const proposals = Router();
  proposals.post("/:proposalId/approve", guard, async (req, res) => {
    const updated = await approve(ctx.db, queryAccountId(req), pathParam(req, "proposalId"));
    if (!updated) {
      res.status(404).json({ error: "Proposal not found." });
      return;
    }
    res.json(updated);
  });
  proposals.post("/:proposalId/reject", guard, async (req, res) => {
    const updated = await reject(ctx.db, queryAccountId(req), pathParam(req, "proposalId"));
    if (!updated) {
      res.status(404).json({ error: "Proposal not found." });
      return;
    }
    res.json(updated);
  });
  return proposals;
}
