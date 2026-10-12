/**
 * YouTube tools: upload and manage videos, playlists, comments, captions, and read analytics.
 * Why on the server: the Google token is minted and used here and never
 * reaches the account's computer. A video is read from that computer as a
 * stream and sent to YouTube with its resumable upload, so an upload that
 * breaks partway carries on from the byte YouTube last received.
 * API: YouTube Data API v3 and YouTube Analytics API v2.
 */
import { computerFile, openFile, type ComputerFile } from "./files.js";
import { callJson, count, list, sendStream, sleep, text, withUploadSlot, type Args, type Json } from "./http.js";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
const PRIVACY = ["public", "unlisted", "private"];

export type Computer = { accountId: string; profile?: string | null };

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function api(path: string, token: string, params: Record<string, string | undefined>, init: RequestInit = {}): Promise<Json> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, value);
  return callJson(`${API}${path}?${query}`, {
    ...init,
    headers: auth(token, init.body ? { "content-type": "application/json" } : {}),
  });
}

function privacyOf(value: unknown): string | undefined {
  const privacy = text(value)?.toLowerCase();
  if (privacy && !PRIVACY.includes(privacy)) throw new Error(`privacy must be one of: ${PRIVACY.join(", ")}.`);
  return privacy;
}

/**
 * Sends a file with YouTube's resumable upload.
 * Input: the session-start address, the token, the JSON that describes the item, and the file.
 * Output: the created resource. A dropped connection or a 5xx is resumed
 * from the byte YouTube reports, up to six tries.
 */
export async function resumableUpload(startUrl: string, token: string, metadata: Json, file: ComputerFile, mime = file.mime): Promise<Json> {
  const started = await fetch(startUrl, {
    method: "POST",
    headers: auth(token, {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(file.size),
      "x-upload-content-type": mime,
    }),
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(30_000),
  });
  const session = started.headers.get("location");
  if (!started.ok || !session) throw new Error(`YouTube did not start the upload: ${(await started.text()).slice(0, 400) || started.status}`);
  let offset = 0;
  let failure = "The upload did not finish.";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      // Never assume how much arrived: ask.
      const status = await sendStream("PUT", session, auth(token, { "content-length": "0", "content-range": `bytes */${file.size}` }), null).catch(() => null);
      if (!status) continue;
      if (status.status === 200 || status.status === 201) return JSON.parse(status.text) as Json;
      if (status.status === 404) throw new Error("YouTube's upload session expired. Start the upload again.");
      if (status.status !== 308) throw new Error(`YouTube refused the upload: ${status.text.slice(0, 400) || status.status}`);
      const range = /bytes=0-(\d+)/.exec(status.headers.range ?? "");
      offset = range ? Number(range[1]) + 1 : 0;
    }
    const opened = await openFile(file, offset);
    try {
      const sent = await sendStream(
        "PUT",
        session,
        auth(token, {
          "content-length": String(file.size - offset),
          "content-type": mime,
          ...(offset > 0 ? { "content-range": `bytes ${offset}-${file.size - 1}/${file.size}` } : {}),
        }),
        opened.stream,
      );
      if (sent.status === 200 || sent.status === 201) return JSON.parse(sent.text) as Json;
      failure = `YouTube answered ${sent.status}: ${sent.text.slice(0, 400)}`;
      if (sent.status === 404) throw new Error("YouTube's upload session expired. Start the upload again.");
      if (![308, 500, 502, 503, 504].includes(sent.status)) throw new Error(failure);
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("YouTube answered") || error.message.includes("session expired"))) throw error;
      failure = error instanceof Error ? error.message : failure;
    } finally {
      opened.stop();
    }
  }
  throw new Error(`The upload kept failing. Last problem: ${failure}`);
}

function videoCard(video: Json): Json {
  return {
    id: video.id,
    url: `https://youtu.be/${video.id}`,
    title: video.snippet?.title,
    description: video.snippet?.description?.slice(0, 500),
    tags: video.snippet?.tags,
    categoryId: video.snippet?.categoryId,
    publishedAt: video.snippet?.publishedAt,
    privacy: video.status?.privacyStatus,
    publishAt: video.status?.publishAt,
    uploadStatus: video.status?.uploadStatus,
    rejectionReason: video.status?.rejectionReason,
    failureReason: video.status?.failureReason,
    madeForKids: video.status?.madeForKids,
    duration: video.contentDetails?.duration,
    views: video.statistics?.viewCount,
    likes: video.statistics?.likeCount,
    comments: video.statistics?.commentCount,
    processing: video.processingDetails?.processingStatus,
  };
}

/** The status block of a video from the tool's arguments; only what was given. */
function statusFrom(args: Args): Json {
  const status: Json = {};
  const privacy = privacyOf(args.privacy);
  if (privacy) status.privacyStatus = privacy;
  if (text(args.publishAt)) {
    // YouTube publishes a scheduled video only from private.
    status.publishAt = text(args.publishAt);
    status.privacyStatus = "private";
  }
  if (typeof args.madeForKids === "boolean") status.selfDeclaredMadeForKids = args.madeForKids;
  if (typeof args.embeddable === "boolean") status.embeddable = args.embeddable;
  if (text(args.license)) status.license = text(args.license);
  if (typeof args.containsSyntheticMedia === "boolean") status.containsSyntheticMedia = args.containsSyntheticMedia;
  if (typeof args.publicStatsViewable === "boolean") status.publicStatsViewable = args.publicStatsViewable;
  return status;
}

async function myChannel(token: string): Promise<Json> {
  const listed = await api("/channels", token, { part: "snippet,statistics,contentDetails,brandingSettings", mine: "true" });
  const channel = (listed.items ?? [])[0] as Json | undefined;
  if (!channel) throw new Error("This Google account has no YouTube channel. Create one at youtube.com first.");
  return channel;
}

/**
 * Runs one YouTube tool.
 * Input: the tool name, its arguments, a Google access token, and whose computer files come from.
 * Output: a small object for the agent.
 */
export async function youtube(tool: string, args: Args, token: string, computer: Computer): Promise<unknown> {
  switch (tool) {
    case "channel": {
      const channel = await myChannel(token);
      return {
        id: channel.id,
        title: channel.snippet?.title,
        handle: channel.snippet?.customUrl,
        description: channel.snippet?.description?.slice(0, 500),
        country: channel.snippet?.country,
        subscribers: channel.statistics?.subscriberCount,
        views: channel.statistics?.viewCount,
        videos: channel.statistics?.videoCount,
        uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
        keywords: channel.brandingSettings?.channel?.keywords,
      };
    }
    case "update_channel": {
      const channel = await myChannel(token);
      const settings: Json = { ...(channel.brandingSettings?.channel ?? {}) };
      if (typeof args.description === "string") settings.description = args.description;
      if (typeof args.keywords === "string") settings.keywords = args.keywords;
      if (text(args.country)) settings.country = text(args.country);
      if (text(args.defaultLanguage)) settings.defaultLanguage = text(args.defaultLanguage);
      await api("/channels", token, { part: "brandingSettings" }, { method: "PUT", body: JSON.stringify({ id: channel.id, brandingSettings: { channel: settings } }) });
      return { id: channel.id, message: "Channel updated." };
    }
    case "upload_video": {
      const file = await computerFile(computer.accountId, computer.profile, args.path);
      const title = text(args.title);
      if (!title) throw new Error("A video needs a title.");
      const snippet: Json = { title: title.slice(0, 100), description: String(args.description ?? "").slice(0, 5000), tags: list(args.tags) };
      if (text(args.categoryId)) snippet.categoryId = text(args.categoryId);
      if (text(args.language)) snippet.defaultLanguage = text(args.language);
      const status = { privacyStatus: "private", selfDeclaredMadeForKids: false, ...statusFrom(args) };
      const body: Json = { snippet, status };
      const parts = ["snippet", "status"];
      if (text(args.recordingDate)) {
        body.recordingDetails = { recordingDate: text(args.recordingDate) };
        parts.push("recordingDetails");
      }
      const notify = typeof args.notifySubscribers === "boolean" ? `&notifySubscribers=${args.notifySubscribers}` : "";
      const video = await withUploadSlot(computer.accountId, () =>
        resumableUpload(`${UPLOAD}/videos?uploadType=resumable&part=${parts.join(",")}${notify}`, token, body, file, file.mime.startsWith("video/") ? file.mime : "application/octet-stream"),
      );
      const done: Json = { ...videoCard(video), message: "Uploaded. YouTube is processing it; it can take a few minutes before it plays." };
      // The video is up whatever happens next, so a failed extra is reported, not thrown.
      const notes: string[] = [];
      if (text(args.thumbnailPath)) {
        await setThumbnail(String(video.id), args.thumbnailPath, token, computer).catch((error: unknown) => notes.push(`Thumbnail not set: ${error instanceof Error ? error.message : "failed"}`));
      }
      if (text(args.playlistId)) {
        await api("/playlistItems", token, { part: "snippet" }, { method: "POST", body: JSON.stringify({ snippet: { playlistId: text(args.playlistId), resourceId: { kind: "youtube#video", videoId: video.id } } }) }).catch(
          (error: unknown) => notes.push(`Not added to the playlist: ${error instanceof Error ? error.message : "failed"}`),
        );
      }
      if (notes.length > 0) done.notes = notes;
      return done;
    }
    case "list_videos": {
      const channel = await myChannel(token);
      const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
      const page = await api("/playlistItems", token, { part: "contentDetails", playlistId: uploads, maxResults: String(count(args.maxResults, 10, 50)), pageToken: text(args.pageToken) });
      const ids = ((page.items ?? []) as Json[]).map((item) => item.contentDetails?.videoId).filter(Boolean);
      const videos = ids.length > 0 ? await api("/videos", token, { part: "snippet,status,statistics,contentDetails", id: ids.join(",") }) : { items: [] };
      return { videos: ((videos.items ?? []) as Json[]).map(videoCard), nextPageToken: page.nextPageToken };
    }
    case "get_video": {
      const found = await api("/videos", token, { part: "snippet,status,statistics,contentDetails,processingDetails", id: text(args.id) });
      const video = (found.items ?? [])[0] as Json | undefined;
      if (!video) throw new Error("No video with that id on this channel.");
      return videoCard(video);
    }
    case "update_video": {
      const id = text(args.id);
      if (!id) throw new Error("Give the video id.");
      const found = await api("/videos", token, { part: "snippet,status", id });
      const video = (found.items ?? [])[0] as Json | undefined;
      if (!video) throw new Error("No video with that id on this channel.");
      // An update replaces the whole part, so what was there is carried over.
      const snippet: Json = { title: video.snippet?.title, description: video.snippet?.description, tags: video.snippet?.tags, categoryId: video.snippet?.categoryId, defaultLanguage: video.snippet?.defaultLanguage };
      if (text(args.title)) snippet.title = text(args.title)?.slice(0, 100);
      if (typeof args.description === "string") snippet.description = args.description.slice(0, 5000);
      if (args.tags !== undefined) snippet.tags = list(args.tags);
      if (text(args.categoryId)) snippet.categoryId = text(args.categoryId);
      if (text(args.language)) snippet.defaultLanguage = text(args.language);
      const status: Json = {
        privacyStatus: video.status?.privacyStatus,
        embeddable: video.status?.embeddable,
        license: video.status?.license,
        selfDeclaredMadeForKids: video.status?.selfDeclaredMadeForKids,
        publicStatsViewable: video.status?.publicStatsViewable,
        ...(video.status?.publishAt ? { publishAt: video.status.publishAt } : {}),
        ...statusFrom(args),
      };
      const updated = await api("/videos", token, { part: "snippet,status" }, { method: "PUT", body: JSON.stringify({ id, snippet, status }) });
      return { ...videoCard(updated), message: "Video updated." };
    }
    case "delete_video":
      await api("/videos", token, { id: text(args.id) }, { method: "DELETE" });
      return { id: args.id, message: "Video deleted. This cannot be undone." };
    case "set_thumbnail":
      return setThumbnail(String(args.videoId ?? ""), args.path, token, computer);
    case "rate_video": {
      const rating = text(args.rating) ?? "like";
      if (!["like", "dislike", "none"].includes(rating)) throw new Error("rating must be like, dislike or none.");
      await api("/videos/rate", token, { id: text(args.id), rating }, { method: "POST" });
      return { id: args.id, rating };
    }
    case "list_playlists": {
      const page = await api("/playlists", token, { part: "snippet,status,contentDetails", mine: "true", maxResults: String(count(args.maxResults, 25, 50)), pageToken: text(args.pageToken) });
      return {
        playlists: ((page.items ?? []) as Json[]).map((item) => ({ id: item.id, title: item.snippet?.title, description: item.snippet?.description?.slice(0, 300), privacy: item.status?.privacyStatus, videos: item.contentDetails?.itemCount })),
        nextPageToken: page.nextPageToken,
      };
    }
    case "create_playlist": {
      if (!text(args.title)) throw new Error("A playlist needs a title.");
      const made = await api("/playlists", token, { part: "snippet,status" }, { method: "POST", body: JSON.stringify({ snippet: { title: text(args.title), description: String(args.description ?? "") }, status: { privacyStatus: privacyOf(args.privacy) ?? "private" } }) });
      return { id: made.id, url: `https://www.youtube.com/playlist?list=${made.id}`, message: "Playlist created." };
    }
    case "update_playlist": {
      const id = text(args.id);
      const found = await api("/playlists", token, { part: "snippet,status", id });
      const playlist = (found.items ?? [])[0] as Json | undefined;
      if (!playlist) throw new Error("No playlist with that id on this channel.");
      const snippet = { title: text(args.title) ?? playlist.snippet?.title, description: typeof args.description === "string" ? args.description : playlist.snippet?.description };
      const status = { privacyStatus: privacyOf(args.privacy) ?? playlist.status?.privacyStatus };
      await api("/playlists", token, { part: "snippet,status" }, { method: "PUT", body: JSON.stringify({ id, snippet, status }) });
      return { id, message: "Playlist updated." };
    }
    case "delete_playlist":
      await api("/playlists", token, { id: text(args.id) }, { method: "DELETE" });
      return { id: args.id, message: "Playlist deleted." };
    case "list_playlist_items": {
      const page = await api("/playlistItems", token, { part: "snippet,contentDetails", playlistId: text(args.playlistId), maxResults: String(count(args.maxResults, 25, 50)), pageToken: text(args.pageToken) });
      return {
        items: ((page.items ?? []) as Json[]).map((item) => ({ itemId: item.id, videoId: item.contentDetails?.videoId, title: item.snippet?.title, position: item.snippet?.position })),
        nextPageToken: page.nextPageToken,
      };
    }
    case "add_to_playlist": {
      const snippet: Json = { playlistId: text(args.playlistId), resourceId: { kind: "youtube#video", videoId: text(args.videoId) } };
      if (typeof args.position === "number") snippet.position = args.position;
      const made = await api("/playlistItems", token, { part: "snippet" }, { method: "POST", body: JSON.stringify({ snippet }) });
      return { itemId: made.id, message: "Added to the playlist." };
    }
    case "remove_from_playlist":
      await api("/playlistItems", token, { id: text(args.itemId) }, { method: "DELETE" });
      return { itemId: args.itemId, message: "Removed from the playlist." };
    case "list_comments": {
      const params: Record<string, string | undefined> = {
        part: "snippet,replies",
        maxResults: String(count(args.maxResults, 20, 100)),
        pageToken: text(args.pageToken),
        order: text(args.order),
        searchTerms: text(args.searchTerms),
        moderationStatus: text(args.moderationStatus),
        textFormat: "plainText",
      };
      if (text(args.videoId)) params.videoId = text(args.videoId);
      else params.allThreadsRelatedToChannelId = (await myChannel(token)).id;
      const page = await api("/commentThreads", token, params);
      return {
        threads: ((page.items ?? []) as Json[]).map((thread) => {
          const top = thread.snippet?.topLevelComment;
          return {
            commentId: top?.id,
            videoId: thread.snippet?.videoId,
            author: top?.snippet?.authorDisplayName,
            text: top?.snippet?.textDisplay?.slice(0, 1000),
            likes: top?.snippet?.likeCount,
            publishedAt: top?.snippet?.publishedAt,
            replyCount: thread.snippet?.totalReplyCount,
            replies: ((thread.replies?.comments ?? []) as Json[]).map((reply) => ({ commentId: reply.id, author: reply.snippet?.authorDisplayName, text: reply.snippet?.textDisplay?.slice(0, 500) })),
          };
        }),
        nextPageToken: page.nextPageToken,
      };
    }
    case "post_comment": {
      const made = await api("/commentThreads", token, { part: "snippet" }, { method: "POST", body: JSON.stringify({ snippet: { videoId: text(args.videoId), topLevelComment: { snippet: { textOriginal: String(args.text ?? "") } } } }) });
      return { commentId: made.snippet?.topLevelComment?.id, message: "Comment posted." };
    }
    case "reply_to_comment": {
      const made = await api("/comments", token, { part: "snippet" }, { method: "POST", body: JSON.stringify({ snippet: { parentId: text(args.commentId), textOriginal: String(args.text ?? "") } }) });
      return { commentId: made.id, message: "Reply posted." };
    }
    case "update_comment":
      await api("/comments", token, { part: "snippet" }, { method: "PUT", body: JSON.stringify({ id: text(args.commentId), snippet: { textOriginal: String(args.text ?? "") } }) });
      return { commentId: args.commentId, message: "Comment updated." };
    case "moderate_comment": {
      const status = text(args.status) ?? "";
      if (!["heldForReview", "published", "rejected"].includes(status)) throw new Error("status must be heldForReview, published or rejected.");
      await api("/comments/setModerationStatus", token, { id: list(args.commentIds).join(","), moderationStatus: status, banAuthor: args.banAuthor === true ? "true" : undefined }, { method: "POST" });
      return { commentIds: list(args.commentIds), status };
    }
    case "delete_comment":
      await api("/comments", token, { id: text(args.commentId) }, { method: "DELETE" });
      return { commentId: args.commentId, message: "Comment deleted." };
    case "list_captions": {
      const page = await api("/captions", token, { part: "snippet", videoId: text(args.videoId) });
      return { captions: ((page.items ?? []) as Json[]).map((item) => ({ id: item.id, language: item.snippet?.language, name: item.snippet?.name, kind: item.snippet?.trackKind, draft: item.snippet?.isDraft, status: item.snippet?.status })) };
    }
    case "upload_caption": {
      const file = await computerFile(computer.accountId, computer.profile, args.path);
      if (!text(args.videoId) || !text(args.language)) throw new Error("A caption track needs videoId and language (for example en).");
      const made = await resumableUpload(
        `${UPLOAD}/captions?uploadType=resumable&part=snippet`,
        token,
        { snippet: { videoId: text(args.videoId), language: text(args.language), name: String(args.name ?? ""), isDraft: args.isDraft === true } },
        file,
        "application/octet-stream",
      );
      return { id: made.id, language: made.snippet?.language, message: "Caption track uploaded." };
    }
    case "download_caption": {
      const response = await fetch(`${API}/captions/${encodeURIComponent(String(args.id ?? ""))}?tfmt=${encodeURIComponent(text(args.format) ?? "srt")}`, { headers: auth(token), signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`YouTube refused: ${body.slice(0, 300) || response.status}`);
      return { id: args.id, text: body.slice(0, 15_000) };
    }
    case "delete_caption":
      await api("/captions", token, { id: text(args.id) }, { method: "DELETE" });
      return { id: args.id, message: "Caption track deleted." };
    case "search": {
      const params: Record<string, string | undefined> = {
        part: "snippet",
        q: text(args.query),
        type: text(args.type) ?? "video",
        order: text(args.order),
        maxResults: String(count(args.maxResults, 10, 50)),
        channelId: text(args.channelId),
        publishedAfter: text(args.publishedAfter),
        pageToken: text(args.pageToken),
      };
      if (args.mine === true) params.forMine = "true";
      const page = await api("/search", token, params);
      return {
        results: ((page.items ?? []) as Json[]).map((item) => ({ videoId: item.id?.videoId, channelId: item.id?.channelId ?? item.snippet?.channelId, playlistId: item.id?.playlistId, title: item.snippet?.title, channel: item.snippet?.channelTitle, publishedAt: item.snippet?.publishedAt, description: item.snippet?.description?.slice(0, 200) })),
        nextPageToken: page.nextPageToken,
      };
    }
    case "list_categories": {
      const page = await api("/videoCategories", token, { part: "snippet", regionCode: text(args.regionCode) ?? "US" });
      return { categories: ((page.items ?? []) as Json[]).filter((item) => item.snippet?.assignable).map((item) => ({ id: item.id, title: item.snippet?.title })) };
    }
    case "analytics": {
      if (!text(args.startDate) || !text(args.endDate)) throw new Error("Give startDate and endDate as YYYY-MM-DD.");
      const query = new URLSearchParams({
        ids: "channel==MINE",
        startDate: String(text(args.startDate)),
        endDate: String(text(args.endDate)),
        metrics: list(args.metrics).join(",") || "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost",
      });
      if (list(args.dimensions).length > 0) query.set("dimensions", list(args.dimensions).join(","));
      if (text(args.filters)) query.set("filters", String(text(args.filters)));
      if (text(args.sort)) query.set("sort", String(text(args.sort)));
      if (args.maxResults !== undefined) query.set("maxResults", String(count(args.maxResults, 10, 200)));
      const report = await callJson(`${ANALYTICS}?${query}`, { headers: auth(token) });
      return { columns: ((report.columnHeaders ?? []) as Json[]).map((column) => column.name), rows: report.rows ?? [] };
    }
    default:
      throw new Error(`Unknown YouTube tool ${tool}.`);
  }
}

async function setThumbnail(videoId: string, path: unknown, token: string, computer: Computer): Promise<Json> {
  if (!videoId) throw new Error("Give the video id.");
  const file = await computerFile(computer.accountId, computer.profile, path);
  if (!["image/jpeg", "image/png"].includes(file.mime)) throw new Error("A thumbnail must be a JPEG or PNG file.");
  if (file.size > 2 * 1024 * 1024) throw new Error("A thumbnail must be 2 MB or smaller. Shrink it and try again.");
  const opened = await openFile(file);
  try {
    const sent = await sendStream("POST", `${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, auth(token, { "content-type": file.mime, "content-length": String(file.size) }), opened.stream);
    if (sent.status !== 200) throw new Error(`YouTube refused the thumbnail: ${sent.text.slice(0, 300) || sent.status}`);
    return { videoId, message: "Thumbnail set." };
  } finally {
    opened.stop();
  }
}
