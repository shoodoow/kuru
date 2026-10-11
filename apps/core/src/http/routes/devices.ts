import { deviceSchema } from "@kuru/shared";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { devices } from "../../db/schema.js";
import { queryAccountId, type AppContext, type Guard } from "../context.js";

/**
 * Routes under /devices: the phones that receive push notifications.
 * Input: the request context and the session guard. Output: the router.
 */
export function devicesRoutes(ctx: AppContext, guard: Guard): Router {
  const router = Router();
  router.post("/", guard, async (req, res) => {
    // Upserts one push device per account. Why: token refresh rotates the
    // ExpoPushToken — upsert on the token keeps exactly one row per device.
    // Invalid tokens 400 here so the phone can fall back to polling visibly.
    const data = deviceSchema.parse(req.body);
    const accountId = queryAccountId(req);
    const [existing] = await ctx.db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.expoPushToken, data.expoPushToken));
    if (existing) {
      await ctx.db
        .update(devices)
        .set({ accountId, platform: data.platform ?? null })
        .where(eq(devices.id, existing.id));
      res.json({ id: existing.id });
      return;
    }
    const [saved] = await ctx.db
      .insert(devices)
      .values({ accountId, expoPushToken: data.expoPushToken, platform: data.platform ?? null })
      .returning();
    res.status(201).json({ id: saved!.id });
  });
  return router;
}
