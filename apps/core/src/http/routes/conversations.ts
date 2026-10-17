import { reactionSchema } from "@kuru/agent-tools";
import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { config } from "../../config.js";
import { agents, messages } from "../../db/schema.js";
import { prompt } from "../../prompt/prompts.js";
import { listEventsSince } from "../../rooms/events.js";
import { markRead } from "../../rooms/inbox.js";
import {
  addMember,
  findRoom,
  getMessage,
  listMembers,
  listMessages,
  listReactions,
  readMessage,
  saveUserMessage,
} from "../../rooms/rooms.js";
import { acquireRun, RoomBusyError } from "../../rooms/runs.js";
import { blocksToText, saveReaction, withWidgetProps } from "../../rooms/send-message.js";
import { isUnsetAgent } from "../../roster/roster.js";
import { attach, publish, type StreamEvent } from "../../rooms/stream.js";
import { runTurn } from "../../rooms/turn.js";
import { fileSize, mimeForName } from "../../rooms/uploads.js";
import { execStream } from "../../linux/linux.js";
import { buildChatContextInfo } from "../../turn/usage/chat-context.js";
import { logger, pathParam, queryAccountId, UUID, type AppContext, type Guard } from "../context.js";
import { startCueTurn } from "../wake.js";
import { startFirstHello } from "../../turn/first-hello.js";

/**
 * Routes under /conversations/:conversationId: messages, reactions, cues, the live stream, members.
 * Input: the request context and the session guard. Output: the router.
 */
export function conversationsRoutes(ctx: AppContext, guard: Guard): Router {
  const conversations = Router();
  conversations.get("/:conversationId/messages", guard, async (req, res) => {
    const limit = Number(req.query.limit);
    const before = typeof req.query.before === "string" ? req.query.before : "";
    if (before && !UUID.test(before)) {
      res.status(400).json({ error: "before must be a message id." });
      return;
    }
    const rows = await listMessages(ctx.db, queryAccountId(req), pathParam(req, "conversationId"), {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      before: before || undefined,
    });
    if (!rows) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(rows);
  });
  conversations.get("/:conversationId/reactions", guard, async (req, res) => {
    res.json(await listReactions(ctx.db, queryAccountId(req), pathParam(req, "conversationId")));
  });
  conversations.get("/:conversationId/blob/:messageId/:index", guard, async (req, res) => {
    // Serves one stripped attachment's bytes for lazy image rendering.
    // Ownership re-checked per request; index selects the block in payload.
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const row = await getMessage(ctx.db, accountId, conversationId, pathParam(req, "messageId"));
    const index = Number(pathParam(req, "index"));
    const blocks = Array.isArray(row?.payload) ? (row.payload as Record<string, unknown>[]) : [];
    const block = Number.isInteger(index) ? blocks[index] : undefined;
    const url = typeof block?.url === "string" ? (block.url as string) : "";
    const preview = typeof block?.previewUrl === "string" ? (block.previewUrl as string) : "";
    if (row && block?.remote === true) {
      // The bytes are on the agent's computer; the phone streams them from the route below.
      res.json({ streamPath: `/conversations/${conversationId}/file/${row.id}/${index}` });
      return;
    }
    if (!row || !block || (url === "" && preview === "")) {
      res.status(404).json({ error: "Attachment not found." });
      return;
    }
    res.json({ url: url !== "" ? url : undefined, previewUrl: preview !== "" ? preview : undefined });
  });
  // Streams one large attachment straight from the agent's computer, as the
  // agent made it. Range requests are honoured so a video can start and seek
  // without the whole file. The path comes from the stored message, never
  // from the request, and the file is read as the agent that sent it.
  conversations.get("/:conversationId/file/:messageId/:index", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const row = await getMessage(ctx.db, accountId, pathParam(req, "conversationId"), pathParam(req, "messageId"));
    const index = Number(pathParam(req, "index"));
    const blocks = Array.isArray(row?.payload) ? (row.payload as Record<string, unknown>[]) : [];
    const block = Number.isInteger(index) ? blocks[index] : undefined;
    const path = block?.remote === true && typeof block.savedPath === "string" ? block.savedPath : "";
    const [sender] = row?.agentId
      ? await ctx.db
          .select({ linuxProfile: agents.linuxProfile })
          .from(agents)
          .where(and(eq(agents.id, row.agentId), eq(agents.accountId, accountId)))
      : [];
    const size = path && sender?.linuxProfile ? await fileSize(accountId, path, sender.linuxProfile) : null;
    if (!path || !sender?.linuxProfile || size === null) {
      res.status(404).json({ error: "This file is no longer on the agent's computer." });
      return;
    }
    const range = byteRange(req.headers.range, size);
    if (range === "invalid") {
      res.status(416).set("Content-Range", `bytes */${size}`).end();
      return;
    }
    const start = range?.start ?? 0;
    const length = range ? range.end - range.start + 1 : size;
    const name = typeof block?.name === "string" ? block.name : "file";
    res.status(range ? 206 : 200).set({
      "Content-Type": typeof block?.mime === "string" && block.mime ? block.mime : mimeForName(name),
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ...(range ? { "Content-Range": `bytes ${start}-${start + length - 1}/${size}` } : {}),
    });
    if (req.method === "HEAD" || length === 0) {
      res.end();
      return;
    }
    const file = await execStream(
      accountId,
      ["sh", "-c", 'tail -c "+$2" -- "$1" | head -c "$3"', "send", path, String(start + 1), String(length)],
      sender.linuxProfile,
    );
    res.on("close", file.stop);
    file.output.pipe(res);
  });
  conversations.post("/:conversationId/reactions", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    if (!(await findRoom(ctx.db, accountId, conversationId))) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const parsed = reactionSchema.parse(req.body);
    const target = await getMessage(ctx.db, accountId, conversationId, parsed.messageId);
    if (!target) {
      res.status(404).json({ error: "Reaction target is not in this room." });
      return;
    }
    const { reaction, created } = await ctx.db.transaction(async (tx) =>
      saveReaction(tx, {
        accountId,
        conversationId,
        agentId: null,
        messageId: parsed.messageId,
        emoji: parsed.emoji,
      }),
    );
    publish(accountId, conversationId, { type: "reaction", reaction: reaction });
    // First user tapback on an agent message wakes that agent via cue (no chat bubble).
    // Why: reactions never became chat text, so without a cue turn the model never sees them.
    if (created && target.agentId) {
      const snippet = target.body.replace(/\s+/g, " ").trim().slice(0, 240);
      const cue = prompt("cues", "reaction", { emoji: parsed.emoji, snippet, messageId: target.id });
      // A reaction while the agent is mid-turn is saved and shown; it just
      // does not start a second turn. The agent sees it in history next time.
      await startCueTurn(ctx, { accountId, conversationId, cue, speakerId: target.agentId, label: "reaction", quietOk: true }).catch(
        (error: unknown) => {
          logger.error({ err: error, conversationId }, "reaction turn acquire failed");
        },
      );
    }
    res.status(201).json(reaction);
  });
  // The person has this chat open: everything in it so far counts as seen.
  conversations.post("/:conversationId/read", guard, async (req, res) => {
    if (!(await markRead(ctx.db, queryAccountId(req), pathParam(req, "conversationId")))) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json({ ok: true });
  });
  // A chat the person just created by hand: its agent writes the first message.
  conversations.post("/:conversationId/hello", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const room = await findRoom(ctx.db, accountId, conversationId);
    if (!room || room.kind !== "direct" || !room.ownerAgentId) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const [owner] = await ctx.db
      .select({ kind: agents.kind, jobDescription: agents.jobDescription })
      .from(agents)
      .where(and(eq(agents.id, room.ownerAgentId), eq(agents.accountId, accountId)));
    startFirstHello(ctx.db, {
      accountId,
      conversationId,
      agentId: room.ownerAgentId,
      kind: owner?.kind ?? "work",
      unset: owner ? isUnsetAgent(owner) : false,
      generate: ctx.generate,
      skillsRoot: config.skillsDir(),
    });
    res.status(202).json({ accepted: true });
  });
  conversations.post("/:conversationId/cues", guard, async (req, res) => {
    // Widget picks / secret-saved wakes: cue-only turns (no user chat bubble).
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const cue = typeof (req.body ?? {}).cue === "string" ? String((req.body as { cue: string }).cue).trim() : "";
    if (!cue || cue.length > 2_000) {
      res.status(400).json({ error: "cue is required (1–2000 chars)." });
      return;
    }
    const room = await findRoom(ctx.db, accountId, conversationId);
    if (!room) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const messageId = typeof (req.body ?? {}).messageId === "string" ? String((req.body as { messageId: string }).messageId) : "";
    const selected = typeof (req.body ?? {}).selected === "string" ? String((req.body as { selected: string }).selected) : "";
    if (messageId && selected) {
      const row = await getMessage(ctx.db, accountId, conversationId, messageId);
      if (row?.payload) {
        // A question, or a handover card answered with "I'm done" or "Skip".
        const answered = withWidgetProps(withWidgetProps(row.payload, "question", { selected }), "desktop-handover", { selected });
        const [updated] = await ctx.db
          .update(messages)
          // The body is what the agent reads as history, so it records the answer too.
          .set({ payload: answered, body: blocksToText(answered) })
          .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId), eq(messages.conversationId, conversationId)))
          .returning();
        if (updated) {
          publish(accountId, conversationId, { type: "message", message: updated });
        }
      }
    }
    const started = await startCueTurn(ctx, { accountId, conversationId, cue, speakerId: room.ownerAgentId, label: "cue" });
    if (!started) {
      res.status(409).json({ error: "Room is busy. Try again in a moment." });
      return;
    }
    res.status(202).json({ accepted: true });
  });
  conversations.get("/:conversationId/stream", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    if (!(await findRoom(ctx.db, accountId, conversationId))) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: ready\ndata: {"conversationId":"${conversationId}"}\n\n`);
    // Resume: replay exactly what the client missed since its cursor, then
    // attach to live fanout. A phone closed for an hour replays the tail and
    // continues live with no gap and no duplicates (client dedups by cursor).
    // Absent cursor = live-only (fresh loads already fetched the thread);
    // present cursor (even 0) = replay everything after it.
    const rawCursor = req.query.cursor;
    const parsedCursor = typeof rawCursor === "string" && rawCursor !== "" ? Number(rawCursor) : NaN;
    if (Number.isFinite(parsedCursor) && parsedCursor >= 0) {
      const missed = await listEventsSince(ctx.db, accountId, conversationId, Math.floor(parsedCursor), 200);
      for (const row of missed) {
        res.write(`data: ${JSON.stringify({ ...(row.payload as Record<string, unknown>), cursor: row.id, conversationId })}\n\n`);
      }
    }
    const detach = attach(res, accountId, conversationId);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // Closed; interval cleared below.
      }
    }, 25000);
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
      (heartbeat as unknown as { unref: () => void }).unref();
    }
    req.on("close", () => {
      clearInterval(heartbeat);
      detach();
    });
  });
  conversations.post("/:conversationId/messages", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const incoming = await readMessage(ctx.db, accountId, conversationId, req.body);
    if (!incoming) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const onEvent = (event: StreamEvent) => publish(accountId, conversationId, event);
    const runJoined = (existingRunId: string, userMessage: { id: string }) =>
      runTurn(ctx.db, accountId, conversationId, incoming, ctx.generate, config.skillsDir(), {
        onEvent,
        alreadySavedUserMessage: { id: userMessage.id, text: incoming.text },
        existingRunId,
      });
    // ?sync=1 preserves the legacy blocking contract for tests and scripts:
    // claim with waiting, run inline, return replies.
    if (req.query.sync === "1") {
      const run = await acquireRun(ctx.db, accountId, conversationId, "turn");
      const userMessage = await saveUserMessage(ctx.db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId: run.id,
      });
      if (!userMessage) {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      const replies = await runJoined(run.id, userMessage);
      res.status(201).json({ message: userMessage, replies });
      return;
    }
    // Default is fail-fast claim + 202: free room -> run now in background
    // (closing the phone never kills the turn); busy room -> message saved
    // queued, and the running turn starts it the moment that turn ends.
    // HTTP never waits on model work.
    try {
      const run = await acquireRun(ctx.db, accountId, conversationId, "turn", 0);
      const userMessage = await saveUserMessage(ctx.db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId: run.id,
      });
      if (!userMessage) {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      void runJoined(run.id, userMessage).catch((error: unknown) => {
        // runTurn already failed the run + emitted the error event; this only logs.
        logger.error({ err: error, conversationId }, "background turn failed");
      });
      res.status(202).json({
        accepted: true,
        message: userMessage,
        stream: `/conversations/${conversationId}/stream?accountId=${accountId}`,
      });
    } catch (error) {
      if (error instanceof RoomBusyError) {
        const userMessage = await saveUserMessage(ctx.db, accountId, conversationId, {
          text: incoming.text,
          blocks: incoming.blocks,
          replyTo: incoming.replyTo,
          queued: true,
        });
        res.status(202).json({
          accepted: true,
          queued: true,
          message: userMessage,
          stream: `/conversations/${conversationId}/stream?accountId=${accountId}`,
        });
        return;
      }
      throw error;
    }
  });
  conversations.post("/:conversationId/members", guard, async (req, res) => {
    const created = await addMember(ctx.db, queryAccountId(req), pathParam(req, "conversationId"), req.body);
    if (!created) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.status(201).json(created);
  });
  conversations.get("/:conversationId/context", guard, async (req, res) => {
    // Per-chat context + accurate usage for the phone header. DB-accurate run
    // totals; the context size is the last run's measured prompt, or an estimate
    // that counts the tools, connector tools and skill list (images excluded).
    const info = await buildChatContextInfo(ctx.db, queryAccountId(req), pathParam(req, "conversationId"), {
      skillsRoot: config.skillsDir(),
    });
    if (!info) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(info);
  });
  conversations.get("/:conversationId/members", guard, async (req, res) => {
    const rows = await listMembers(ctx.db, queryAccountId(req), pathParam(req, "conversationId"));
    if (!rows) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(rows);
  });
  return conversations;
}

/**
 * Reads a Range header for a file of `size` bytes.
 * Output: the first and last byte to send, undefined when there is no usable
 * header (send it all), or "invalid" when the range lies outside the file.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | undefined | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") {
    // "-500": the last 500 bytes.
    const tail = Math.min(Number(match[2]), size);
    return tail > 0 ? { start: size - tail, end: size - 1 } : "invalid";
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size && start <= end ? { start, end } : "invalid";
}
