import { deviceSchema } from "@kuru/shared";
import { and, eq, isNull, ne, or } from "drizzle-orm";
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
    // One row per install of the app. Why: rows were keyed only by token, so
    // every token a phone ever had stayed, Expo Go's among them, and a push
    // sent to that one opened Expo Go instead of the app. When an install
    // registers, its earlier token is replaced and this account's rows on the
    // same platform from before install ids (Expo Go, old builds) are dropped.
    const data = deviceSchema.parse(req.body);
    const accountId = queryAccountId(req);
    const platform = data.platform ?? null;
    const id = await ctx.db.transaction(async (tx) => {
      if (data.installId) {
        await tx
          .delete(devices)
          .where(
            and(
              ne(devices.expoPushToken, data.expoPushToken),
              or(
                eq(devices.installId, data.installId),
                and(eq(devices.accountId, accountId), isNull(devices.installId), platform ? eq(devices.platform, platform) : isNull(devices.platform)),
              ),
            ),
          );
      }
      const [existing] = await tx.select({ id: devices.id }).from(devices).where(eq(devices.expoPushToken, data.expoPushToken));
      if (existing) {
        await tx
          .update(devices)
          .set({ accountId, platform, ...(data.installId ? { installId: data.installId } : {}) })
          .where(eq(devices.id, existing.id));
        return { id: existing.id, created: false };
      }
      const [saved] = await tx
        .insert(devices)
        .values({ accountId, expoPushToken: data.expoPushToken, platform, installId: data.installId ?? null })
        .returning();
      return { id: saved!.id, created: true };
    });
    res.status(id.created ? 201 : 200).json({ id: id.id });
  });
  return router;
}
