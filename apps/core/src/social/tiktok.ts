/**
 * TikTok tools: post videos and photos, send drafts to the inbox, read the account and its videos.
 * Why two ways in: a video's bytes are sent from this server in chunks
 * (FILE_UPLOAD). Photos can only be pulled by TikTok from a public address
 * (PULL_FROM_URL), which TikTok accepts only for a domain verified in its
 * developer portal.
 * Posting is asynchronous on TikTok's side: the tool waits a few minutes for
 * the result and otherwise returns the publish id to check later.
 * API: TikTok Content Posting API and Display API, v2.
 */
import { computerFile, openFile, publicFileUrl, type ComputerFile } from "./files.js";
import { callJson, count, list, sendStream, sleep, text, withUploadSlot, type Args, type Json } from "./http.js";
import type { Computer } from "./youtube.js";

const API = "https://open.tiktokapis.com";
const MB = 1024 * 1024;
const VIDEO_FIELDS = "id,create_time,cover_image_url,share_url,video_description,duration,title,like_count,comment_count,share_count,view_count";
const STATUS_WAIT_MS = 3 * 60_000;

async function tk(path: string, token: string, body?: Json, method: "GET" | "POST" = "POST"): Promise<Json> {
  const reply = await callJson(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const code = reply.error?.code;
  if (code && code !== "ok") throw new Error(`${explain(String(code))} (${code}${reply.error?.message ? `: ${reply.error.message}` : ""})`);
  return (reply.data ?? {}) as Json;
}

/** TikTok's error codes in words that say what to do next. */
function explain(code: string): string {
  const known: Record<string, string> = {
    unaudited_client_can_only_post_to_private_accounts:
      "TikTok has not audited this server's TikTok app yet, so it may only post privately. Post with privacy SELF_ONLY, or use upload_draft so the person finishes the post in the TikTok app",
    privacy_level_option_mismatch: "That privacy setting is not one this account allows. Call creator_info and use one of its privacy options",
    url_ownership_unverified: "TikTok pulls photos from this server only after the server's domain is verified in the TikTok developer portal (URL properties). Ask the person to verify it, or post a video instead",
    spam_risk_too_many_posts: "This account has reached TikTok's daily posting limit. Try again tomorrow",
    spam_risk_too_many_pending_share: "TikTok allows five unfinished drafts per day and this account has reached that. The person has to finish or discard drafts in the TikTok app",
    spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting",
    reached_active_user_cap: "This server's TikTok app has reached its daily number of posting accounts",
    access_token_invalid: "TikTok no longer accepts this sign-in. Connect the TikTok plugin again",
    scope_not_authorized: "The TikTok sign-in did not grant this permission. Connect the TikTok plugin again and allow everything it asks for",
    rate_limit_exceeded: "TikTok is limiting requests. Wait a minute and try again",
  };
  return known[code] ?? "TikTok refused the request";
}

export type ChunkPlan = { chunkSize: number; chunks: { start: number; length: number }[] };

/**
 * Splits a file the way TikTok's upload wants it.
 * TikTok's rules: a chunk is 5 MB to 64 MB; a file under 5 MB goes whole; the
 * number of chunks is the size divided by the chunk size, rounded down, and
 * the last chunk carries the remainder (up to 128 MB).
 * Input: the file size in bytes. Output: the declared chunk size and each chunk's range.
 */
export function chunkPlan(size: number): ChunkPlan {
  if (size <= 64 * MB) return { chunkSize: size, chunks: [{ start: 0, length: size }] };
  const chunkSize = 16 * MB;
  const total = Math.floor(size / chunkSize);
  const chunks = Array.from({ length: total }, (_, index) => ({
    start: index * chunkSize,
    length: index === total - 1 ? size - index * chunkSize : chunkSize,
  }));
  return { chunkSize, chunks };
}

async function sendChunks(uploadUrl: string, file: ComputerFile, plan: ChunkPlan): Promise<void> {
  for (const chunk of plan.chunks) {
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt += 1) {
      if (attempt > 0) await sleep(2_000 * attempt);
      const opened = await openFile(file, chunk.start, chunk.length);
      try {
        const sent = await sendStream(
          "PUT",
          uploadUrl,
          { "content-type": file.mime, "content-length": String(chunk.length), "content-range": `bytes ${chunk.start}-${chunk.start + chunk.length - 1}/${file.size}` },
          opened.stream,
        );
        if (sent.status === 201 || sent.status === 206) done = true;
        else if (sent.status < 500) throw new Error(`TikTok refused the upload (HTTP ${sent.status}): ${sent.text.slice(0, 300)}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("TikTok refused")) throw error;
      } finally {
        opened.stop();
      }
    }
    if (!done) throw new Error("The upload to TikTok kept failing partway. Nothing was posted. Try again.");
  }
}

/** Waits for TikTok to finish a post, then says where it ended up. */
async function settle(publishId: string, token: string): Promise<Json> {
  const deadline = Date.now() + STATUS_WAIT_MS;
  for (;;) {
    const state = await tk("/v2/post/publish/status/fetch/", token, { publish_id: publishId });
    if (state.status === "PUBLISH_COMPLETE") {
      return { publishId, status: state.status, postIds: (state.publicaly_available_post_id ?? []).map(String), message: "Posted on TikTok." };
    }
    if (state.status === "SEND_TO_USER_INBOX") {
      return { publishId, status: state.status, message: "Sent to the person's TikTok inbox. They open the TikTok app, tap the notification, and finish the post there." };
    }
    if (state.status === "FAILED") throw new Error(`TikTok could not post it: ${state.fail_reason ?? "no reason given"}.`);
    if (Date.now() > deadline) {
      return { publishId, status: state.status ?? "PROCESSING", message: "TikTok is still processing it. Check later with post_status and this publishId." };
    }
    await sleep(8_000);
  }
}

function videoFile(file: ComputerFile): void {
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(file.mime)) throw new Error(`TikTok takes MP4, MOV or WebM video; ${file.name} is none of these. Convert it with ffmpeg.`);
  if (file.size > 4 * 1024 * MB) throw new Error("TikTok takes videos up to 4 GB. Compress it with ffmpeg and try again.");
}

async function creatorInfo(token: string): Promise<Json> {
  return tk("/v2/post/publish/creator_info/query/", token, {});
}

/** Checks the privacy asked for against what this account allows. Private when nothing was asked. */
async function privacyFor(args: Args, token: string): Promise<string> {
  const allowed = ((await creatorInfo(token)).privacy_level_options ?? []) as string[];
  const wanted = text(args.privacy) ?? "SELF_ONLY";
  if (allowed.length > 0 && !allowed.includes(wanted)) throw new Error(`privacy must be one of what this account allows: ${allowed.join(", ")}.`);
  return wanted;
}

/**
 * Runs one TikTok tool.
 * Input: the tool name, its arguments, the account's access token, and whose computer files come from.
 * Output: a small object for the agent.
 */
export async function tiktok(tool: string, args: Args, token: string, computer: Computer): Promise<unknown> {
  switch (tool) {
    case "account": {
      const info = await tk(
        "/v2/user/info/?fields=open_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,username,follower_count,following_count,likes_count,video_count",
        token,
        undefined,
        "GET",
      );
      return info.user ?? info;
    }
    case "creator_info": {
      const info = await creatorInfo(token);
      return {
        username: info.creator_username,
        nickname: info.creator_nickname,
        privacyOptions: info.privacy_level_options,
        commentsOff: info.comment_disabled,
        duetOff: info.duet_disabled,
        stitchOff: info.stitch_disabled,
        maxVideoSeconds: info.max_video_post_duration_sec,
      };
    }
    case "post_video": {
      const file = await computerFile(computer.accountId, computer.profile, args.path);
      videoFile(file);
      const privacy = await privacyFor(args, token);
      const plan = chunkPlan(file.size);
      const postInfo: Json = {
        title: String(args.caption ?? "").slice(0, 2200),
        privacy_level: privacy,
        disable_comment: args.disableComment === true,
        disable_duet: args.disableDuet === true,
        disable_stitch: args.disableStitch === true,
        brand_content_toggle: args.brandedContent === true,
        brand_organic_toggle: args.ownBrand === true,
        is_aigc: args.isAiGenerated === true,
      };
      if (typeof args.coverTimestampMs === "number") postInfo.video_cover_timestamp_ms = Math.max(0, Math.floor(args.coverTimestampMs));
      return withUploadSlot(computer.accountId, async () => {
        const started = await tk("/v2/post/publish/video/init/", token, {
          post_info: postInfo,
          source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: plan.chunkSize, total_chunk_count: plan.chunks.length },
        });
        await sendChunks(String(started.upload_url), file, plan);
        return { privacy, ...(await settle(String(started.publish_id), token)) };
      });
    }
    case "upload_draft": {
      const file = await computerFile(computer.accountId, computer.profile, args.path);
      videoFile(file);
      const plan = chunkPlan(file.size);
      return withUploadSlot(computer.accountId, async () => {
        const started = await tk("/v2/post/publish/inbox/video/init/", token, {
          source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: plan.chunkSize, total_chunk_count: plan.chunks.length },
        });
        await sendChunks(String(started.upload_url), file, plan);
        return settle(String(started.publish_id), token);
      });
    }
    case "post_photos": {
      const paths = list(args.paths);
      if (paths.length < 1 || paths.length > 35) throw new Error("A photo post has 1 to 35 photos. Give their paths.");
      const urls: string[] = [];
      for (const path of paths) {
        const photo = await computerFile(computer.accountId, computer.profile, path);
        if (!["image/jpeg", "image/webp"].includes(photo.mime)) throw new Error(`TikTok takes photos as JPEG or WebP; ${photo.name} is neither. Convert it first.`);
        if (photo.size > 20 * MB) throw new Error(`TikTok takes photos up to 20 MB; ${photo.name} is larger.`);
        urls.push(publicFileUrl(photo));
      }
      const draft = args.asDraft === true;
      const postInfo: Json = { title: String(args.title ?? "").slice(0, 90), description: String(args.description ?? "").slice(0, 4000) };
      if (!draft) {
        postInfo.privacy_level = await privacyFor(args, token);
        postInfo.disable_comment = args.disableComment === true;
        postInfo.auto_add_music = args.autoAddMusic !== false;
        postInfo.brand_content_toggle = args.brandedContent === true;
        postInfo.brand_organic_toggle = args.ownBrand === true;
      }
      const started = await tk("/v2/post/publish/content/init/", token, {
        media_type: "PHOTO",
        post_mode: draft ? "MEDIA_UPLOAD" : "DIRECT_POST",
        post_info: postInfo,
        source_info: { source: "PULL_FROM_URL", photo_images: urls, photo_cover_index: Math.min(urls.length - 1, Math.max(0, Number(args.coverIndex) || 0)) },
        ...(args.isAiGenerated === true ? { is_aigc: true } : {}),
      });
      return settle(String(started.publish_id), token);
    }
    case "post_status": {
      const state = await tk("/v2/post/publish/status/fetch/", token, { publish_id: text(args.publishId) });
      return { publishId: args.publishId, status: state.status, failReason: state.fail_reason, postIds: (state.publicaly_available_post_id ?? []).map(String), uploadedBytes: state.uploaded_bytes };
    }
    case "list_videos": {
      const page = await tk(`/v2/video/list/?fields=${VIDEO_FIELDS}`, token, { max_count: count(args.maxCount, 10, 20), ...(args.cursor !== undefined ? { cursor: Number(args.cursor) } : {}) });
      return { videos: page.videos ?? [], cursor: page.cursor, hasMore: page.has_more };
    }
    case "get_videos": {
      const ids = list(args.videoIds);
      if (ids.length === 0 || ids.length > 20) throw new Error("Give 1 to 20 video ids.");
      const page = await tk(`/v2/video/query/?fields=${VIDEO_FIELDS}`, token, { filters: { video_ids: ids } });
      return { videos: page.videos ?? [] };
    }
    default:
      throw new Error(`Unknown TikTok tool ${tool}.`);
  }
}
