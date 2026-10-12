/**
 * Instagram tools: publish photos, reels, stories and carousels, manage comments, read insights.
 * Why links, not uploads: Instagram does not take file bytes from an app. It
 * downloads the photo or video from a public address, so each file is handed
 * over as a short-lived signed link on this server (see files.ts).
 * Publishing is two steps on Instagram's side: a "container" is created and
 * processed, then published. A video container takes a while, so it is polled.
 * API: Instagram API with Instagram Login, for a professional (business or creator) account.
 */
import { computerFile, publicFileUrl, type ComputerFile } from "./files.js";
import { callJson, count, list, sleep, text, type Args, type Json } from "./http.js";
import type { Computer } from "./youtube.js";

export const INSTAGRAM_GRAPH = "https://graph.instagram.com/v25.0";
/** How long a video may take to be processed before the tool gives up waiting. */
const PROCESS_WAIT_MS = 10 * 60_000;
const POLL_MS = 10_000;

function ig(path: string, token: string, params: Record<string, string | undefined> = {}, method: "GET" | "POST" | "DELETE" = "GET"): Promise<Json> {
  const query = new URLSearchParams({ access_token: token });
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, value);
  if (method === "POST") {
    return callJson(`${INSTAGRAM_GRAPH}${path}`, { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: query });
  }
  return callJson(`${INSTAGRAM_GRAPH}${path}?${query}`, { method });
}

function isVideo(file: ComputerFile): boolean {
  return file.mime.startsWith("video/");
}

function requireJpeg(file: ComputerFile): void {
  if (file.mime !== "image/jpeg") {
    throw new Error(`Instagram takes photos as JPEG only, and ${file.name} is not one. Convert it on your computer (for example: convert "${file.path}" out.jpg) and send the JPEG.`);
  }
  if (file.size > 8 * 1024 * 1024) throw new Error(`Instagram takes photos up to 8 MB; ${file.name} is larger. Save it smaller and try again.`);
}

function requireVideo(file: ComputerFile, maxBytes: number, what: string): void {
  if (!["video/mp4", "video/quicktime"].includes(file.mime)) throw new Error(`Instagram takes ${what} as MP4 or MOV; ${file.name} is neither. Convert it with ffmpeg (H.264 video, AAC audio).`);
  if (file.size > maxBytes) throw new Error(`Instagram takes ${what} up to ${Math.round(maxBytes / 1024 / 1024)} MB; ${file.name} is larger. Compress it with ffmpeg and try again.`);
}

/** People tagged in a photo or video, in the shape Instagram wants. */
function userTags(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return JSON.stringify(
    value.map((tag) => {
      const row = tag as Json;
      return { username: String(row.username ?? "").replace(/^@/, ""), ...(typeof row.x === "number" ? { x: row.x } : {}), ...(typeof row.y === "number" ? { y: row.y } : {}) };
    }),
  );
}

/** Settings shared by a feed photo, a reel and a carousel. */
function shared(args: Args): Record<string, string | undefined> {
  const collaborators = list(args.collaborators).map((name) => name.replace(/^@/, ""));
  return {
    caption: typeof args.caption === "string" ? args.caption.slice(0, 2200) : undefined,
    collaborators: collaborators.length > 0 ? JSON.stringify(collaborators.slice(0, 3)) : undefined,
    location_id: text(args.locationId),
    is_ai_generated: typeof args.isAiGenerated === "boolean" ? String(args.isAiGenerated) : undefined,
  };
}

/** Waits until Instagram has finished processing a container. Throws its reason when it fails. */
async function waitUntilReady(containerId: string, token: string): Promise<void> {
  const deadline = Date.now() + PROCESS_WAIT_MS;
  for (;;) {
    const state = await ig(`/${containerId}`, token, { fields: "status_code,status" });
    if (state.status_code === "FINISHED" || state.status_code === "PUBLISHED") return;
    if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
      throw new Error(`Instagram could not process the file (${state.status_code}): ${state.status ?? "no reason given"}. Check the format, length and size against Instagram's limits.`);
    }
    if (Date.now() > deadline) throw new Error("Instagram is still processing the file after ten minutes. Nothing was published. Try again later.");
    await sleep(POLL_MS);
  }
}

async function publish(containerId: string, token: string): Promise<Json> {
  await waitUntilReady(containerId, token);
  const published = await ig("/me/media_publish", token, { creation_id: containerId }, "POST");
  const media = await ig(`/${published.id}`, token, { fields: "id,permalink,media_type,media_product_type,timestamp" }).catch((): Json => ({ id: published.id }));
  return { id: media.id, url: media.permalink, type: media.media_product_type ?? media.media_type, message: "Published on Instagram." };
}

/**
 * Runs one Instagram tool.
 * Input: the tool name, its arguments, the account's access token, and whose computer files come from.
 * Output: a small object for the agent.
 */
export async function instagram(tool: string, args: Args, token: string, computer: Computer): Promise<unknown> {
  const file = (path: unknown) => computerFile(computer.accountId, computer.profile, path);
  switch (tool) {
    case "account": {
      const me = await ig("/me", token, { fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography" });
      const limit = await ig("/me/content_publishing_limit", token, { fields: "quota_usage,config" }).catch(() => null);
      const quota = ((limit?.data ?? [])[0] ?? {}) as Json;
      return { ...me, postsLast24h: quota.quota_usage, postsAllowedPer24h: quota.config?.quota_total };
    }
    case "publish_photo": {
      const photo = await file(args.path);
      requireJpeg(photo);
      const container = await ig("/me/media", token, { image_url: publicFileUrl(photo), alt_text: text(args.altText)?.slice(0, 1000), user_tags: userTags(args.userTags), ...shared(args) }, "POST");
      return publish(String(container.id), token);
    }
    case "publish_reel": {
      const video = await file(args.path);
      requireVideo(video, 300 * 1024 * 1024, "reels");
      const cover = text(args.coverPath) ? await file(args.coverPath) : null;
      if (cover) requireJpeg(cover);
      const trial = text(args.trial);
      if (trial && !["MANUAL", "SS_PERFORMANCE"].includes(trial)) throw new Error("trial must be MANUAL or SS_PERFORMANCE.");
      const container = await ig(
        "/me/media",
        token,
        {
          media_type: "REELS",
          video_url: publicFileUrl(video),
          cover_url: cover ? publicFileUrl(cover) : undefined,
          thumb_offset: typeof args.thumbOffsetMs === "number" ? String(Math.max(0, Math.floor(args.thumbOffsetMs))) : undefined,
          share_to_feed: typeof args.shareToFeed === "boolean" ? String(args.shareToFeed) : undefined,
          audio_name: text(args.audioName),
          user_tags: userTags(args.userTags),
          trial_params: trial ? JSON.stringify({ graduation_strategy: trial }) : undefined,
          ...shared(args),
        },
        "POST",
      );
      return publish(String(container.id), token);
    }
    case "publish_story": {
      const media = await file(args.path);
      if (isVideo(media)) requireVideo(media, 100 * 1024 * 1024, "video stories");
      else requireJpeg(media);
      const container = await ig("/me/media", token, { media_type: "STORIES", [isVideo(media) ? "video_url" : "image_url"]: publicFileUrl(media), user_tags: userTags(args.userTags) }, "POST");
      return publish(String(container.id), token);
    }
    case "publish_carousel": {
      const paths = list(args.paths);
      if (paths.length < 2 || paths.length > 10) throw new Error("A carousel has 2 to 10 photos or videos. Give their paths.");
      const altTexts = Array.isArray(args.altTexts) ? args.altTexts.map(String) : [];
      const children: string[] = [];
      for (const [index, path] of paths.entries()) {
        const item = await file(path);
        if (isVideo(item)) requireVideo(item, 300 * 1024 * 1024, "carousel videos");
        else requireJpeg(item);
        const child = await ig(
          "/me/media",
          token,
          isVideo(item)
            ? { media_type: "VIDEO", video_url: publicFileUrl(item), is_carousel_item: "true" }
            : { image_url: publicFileUrl(item), is_carousel_item: "true", alt_text: altTexts[index]?.slice(0, 1000) },
          "POST",
        );
        children.push(String(child.id));
      }
      // Every item has to be processed before the carousel itself can be made.
      for (const child of children) await waitUntilReady(child, token);
      const container = await ig("/me/media", token, { media_type: "CAROUSEL", children: children.join(","), ...shared(args) }, "POST");
      return publish(String(container.id), token);
    }
    case "list_media": {
      const page = await ig("/me/media", token, { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count", limit: String(count(args.limit, 10, 50)), after: text(args.after) });
      return { media: ((page.data ?? []) as Json[]).map((item) => ({ ...item, caption: item.caption?.slice(0, 300) })), after: page.paging?.cursors?.after };
    }
    case "get_media":
      return ig(`/${text(args.mediaId) ?? ""}`, token, { fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,is_comment_enabled,thumbnail_url,alt_text" });
    case "list_stories": {
      const page = await ig("/me/stories", token, { fields: "id,media_type,permalink,timestamp" });
      return { stories: page.data ?? [] };
    }
    case "list_comments": {
      const page = await ig(`/${text(args.mediaId) ?? ""}/comments`, token, { fields: "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}", limit: String(count(args.limit, 25, 50)), after: text(args.after) });
      return { comments: page.data ?? [], after: page.paging?.cursors?.after };
    }
    case "post_comment": {
      const made = await ig(`/${text(args.mediaId) ?? ""}/comments`, token, { message: String(args.text ?? "") }, "POST");
      return { commentId: made.id, message: "Comment posted." };
    }
    case "reply_to_comment": {
      const made = await ig(`/${text(args.commentId) ?? ""}/replies`, token, { message: String(args.text ?? "") }, "POST");
      return { commentId: made.id, message: "Reply posted." };
    }
    case "hide_comment":
      await ig(`/${text(args.commentId) ?? ""}`, token, { hide: String(args.hide !== false) }, "POST");
      return { commentId: args.commentId, hidden: args.hide !== false };
    case "delete_comment":
      await ig(`/${text(args.commentId) ?? ""}`, token, {}, "DELETE");
      return { commentId: args.commentId, message: "Comment deleted." };
    case "set_comments_enabled":
      await ig(`/${text(args.mediaId) ?? ""}`, token, { comment_enabled: String(args.enabled !== false) }, "POST");
      return { mediaId: args.mediaId, commentsEnabled: args.enabled !== false };
    case "media_insights": {
      const mediaId = text(args.mediaId) ?? "";
      let metrics = list(args.metrics);
      if (metrics.length === 0) {
        // The metrics Instagram accepts depend on what kind of post it is.
        const media = await ig(`/${mediaId}`, token, { fields: "media_product_type" });
        metrics =
          media.media_product_type === "REELS"
            ? ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"]
            : media.media_product_type === "STORY"
              ? ["views", "reach", "replies", "shares", "total_interactions", "navigation"]
              : ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"];
      }
      const report = await ig(`/${mediaId}/insights`, token, { metric: metrics.join(",") });
      return { mediaId, metrics: Object.fromEntries(((report.data ?? []) as Json[]).map((row) => [row.name, row.values?.[0]?.value ?? row.total_value?.value])) };
    }
    case "account_insights": {
      const metrics = list(args.metrics);
      const report = await ig("/me/insights", token, {
        metric: (metrics.length > 0 ? metrics : ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves"]).join(","),
        period: text(args.period) ?? "day",
        metric_type: text(args.metricType) ?? "total_value",
        breakdown: text(args.breakdown),
        timeframe: text(args.timeframe),
        since: text(args.since),
        until: text(args.until),
      });
      return { metrics: ((report.data ?? []) as Json[]).map((row) => ({ name: row.name, period: row.period, total: row.total_value?.value, breakdowns: row.total_value?.breakdowns, values: row.values })) };
    }
    default:
      throw new Error(`Unknown Instagram tool ${tool}.`);
  }
}
