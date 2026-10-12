/**
 * The YouTube, Instagram and TikTok plugins: what each tool is called, what it takes, and what the agent is told about it.
 * The tools run on the server (youtube.ts, instagram.ts, tiktok.ts). A file is
 * always named by its path on the agent's computer; the server reads it from there.
 */
import type { CatalogPlugin } from "../mcp/catalog.js";
import type { McpToolCacheEntry } from "../mcp/types.js";

type Property = Record<string, unknown>;
const s = (description: string): Property => ({ type: "string", description });
const n = (description: string): Property => ({ type: "number", description });
const b = (description: string): Property => ({ type: "boolean", description });
const strings = (description: string): Property => ({ type: "array", items: { type: "string" }, description });

function tool(name: string, description: string, properties: Record<string, Property> = {}, required: string[] = []): McpToolCacheEntry {
  return { name, description, inputSchema: { type: "object", properties, required } };
}

const path = s("Path of the file on your computer, under your home or /shared.");
const pageToken = s("nextPageToken from the previous call, for the next page.");
const privacy = s("public, unlisted or private.");
const tags = {
  type: "array",
  description: "People to tag. x and y (0 to 1) place the tag on a photo.",
  items: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["username"] },
};

const youtubeTools: McpToolCacheEntry[] = [
  tool("channel", "This account's YouTube channel: name, subscribers, views, video count."),
  tool("update_channel", "Change the channel's description, keywords, country or default language.", {
    description: s("New channel description."),
    keywords: s("Space-separated keywords; quote a phrase."),
    country: s("Two-letter country code."),
    defaultLanguage: s("Language code, for example en."),
  }),
  tool(
    "upload_video",
    "Upload a video file from your computer to YouTube. It starts private unless you set privacy. A vertical video up to three minutes is a Short. Set publishAt to schedule it. Returns the video's link.",
    {
      path,
      title: s("Up to 100 characters."),
      description: s("Up to 5000 characters."),
      tags: strings("Keywords."),
      categoryId: s("Category id from list_categories; 22 (People & Blogs) when left out."),
      privacy,
      publishAt: s("When to make it public, ISO 8601 (2026-11-01T15:00:00Z). The video stays private until then."),
      madeForKids: b("True only when the video is made for children."),
      notifySubscribers: b("False to skip the notification to subscribers."),
      language: s("Language of the title and description, for example en."),
      license: s("youtube or creativeCommon."),
      embeddable: b("False to stop other sites embedding it."),
      containsSyntheticMedia: b("True when it shows realistic altered or AI-generated content."),
      recordingDate: s("When it was recorded, ISO 8601."),
      thumbnailPath: s("Path of a JPEG or PNG (up to 2 MB) to use as the thumbnail."),
      playlistId: s("A playlist to add the video to."),
    },
    ["path", "title"],
  ),
  tool("list_videos", "The channel's uploaded videos, newest first, with views, likes and privacy.", { maxResults: n("1 to 50; 10 when left out."), pageToken }),
  tool("get_video", "One video's details, statistics and processing state.", { id: s("Video id.") }, ["id"]),
  tool(
    "update_video",
    "Change a video's title, description, tags, category, privacy, schedule or other settings. Only what you give changes.",
    { id: s("Video id."), title: s("New title."), description: s("New description."), tags: strings("Replaces the tags."), categoryId: s("Category id."), privacy, publishAt: s("Schedule: ISO 8601."), madeForKids: b("Made for children."), embeddable: b("May be embedded."), license: s("youtube or creativeCommon."), language: s("Language code.") },
    ["id"],
  ),
  tool("delete_video", "Delete a video for good.", { id: s("Video id.") }, ["id"]),
  tool("set_thumbnail", "Set a video's thumbnail from a JPEG or PNG on your computer (up to 2 MB).", { videoId: s("Video id."), path }, ["videoId", "path"]),
  tool("rate_video", "Like or dislike a video as the channel, or clear the rating.", { id: s("Video id."), rating: s("like, dislike or none.") }, ["id", "rating"]),
  tool("list_playlists", "The channel's playlists.", { maxResults: n("1 to 50."), pageToken }),
  tool("create_playlist", "Create a playlist. Private unless you set privacy.", { title: s("Playlist title."), description: s("Playlist description."), privacy }, ["title"]),
  tool("update_playlist", "Change a playlist's title, description or privacy.", { id: s("Playlist id."), title: s("New title."), description: s("New description."), privacy }, ["id"]),
  tool("delete_playlist", "Delete a playlist. Its videos stay on the channel.", { id: s("Playlist id.") }, ["id"]),
  tool("list_playlist_items", "The videos in a playlist, with the item id needed to remove one.", { playlistId: s("Playlist id."), maxResults: n("1 to 50."), pageToken }, ["playlistId"]),
  tool("add_to_playlist", "Add a video to a playlist.", { playlistId: s("Playlist id."), videoId: s("Video id."), position: n("Place in the list, from 0.") }, ["playlistId", "videoId"]),
  tool("remove_from_playlist", "Remove one item from a playlist.", { itemId: s("Item id from list_playlist_items.") }, ["itemId"]),
  tool(
    "list_comments",
    "Comments on one video, or across the whole channel when no video is given, with their replies.",
    { videoId: s("Video id; leave out for every video on the channel."), order: s("time or relevance."), searchTerms: s("Only comments containing this."), moderationStatus: s("published, heldForReview or likelySpam."), maxResults: n("1 to 100."), pageToken },
  ),
  tool("post_comment", "Post a new comment on a video as the channel.", { videoId: s("Video id."), text: s("The comment.") }, ["videoId", "text"]),
  tool("reply_to_comment", "Reply to a comment as the channel.", { commentId: s("Id of the comment being answered."), text: s("The reply.") }, ["commentId", "text"]),
  tool("update_comment", "Edit a comment the channel wrote.", { commentId: s("Comment id."), text: s("The new text.") }, ["commentId", "text"]),
  tool("moderate_comment", "Approve, hold or reject comments on the channel's videos.", { commentIds: strings("Comment ids."), status: s("published, heldForReview or rejected."), banAuthor: b("With rejected: also ban the author from the channel.") }, ["commentIds", "status"]),
  tool("delete_comment", "Delete a comment.", { commentId: s("Comment id.") }, ["commentId"]),
  tool("list_captions", "A video's caption tracks.", { videoId: s("Video id.") }, ["videoId"]),
  tool("upload_caption", "Add a caption track to a video from a subtitle file on your computer (SRT, VTT or SBV).", { videoId: s("Video id."), path, language: s("Language code, for example en."), name: s("Track name; empty for the default."), isDraft: b("True to keep it unpublished.") }, ["videoId", "path", "language"]),
  tool("download_caption", "Read a caption track's text.", { id: s("Caption track id."), format: s("srt, vtt or sbv; srt when left out.") }, ["id"]),
  tool("delete_caption", "Delete a caption track.", { id: s("Caption track id.") }, ["id"]),
  tool("search", "Search YouTube for videos, channels or playlists, or only this channel's own videos.", { query: s("What to look for."), mine: b("True to search only this channel's videos."), type: s("video, channel or playlist."), order: s("relevance, date, viewCount or rating."), channelId: s("Only this channel."), publishedAfter: s("ISO 8601."), maxResults: n("1 to 50."), pageToken }),
  tool("list_categories", "Video categories that can be assigned, for one country.", { regionCode: s("Two-letter country code; US when left out.") }),
  tool(
    "analytics",
    "Channel statistics over a date range from YouTube Analytics. Default metrics: views, estimatedMinutesWatched, averageViewDuration, likes, comments, shares, subscribersGained, subscribersLost.",
    {
      startDate: s("YYYY-MM-DD."),
      endDate: s("YYYY-MM-DD."),
      metrics: strings("Metric names, for example views, engagedViews, estimatedMinutesWatched, averageViewPercentage, likes."),
      dimensions: strings("How to split the numbers: day, month, video, country, deviceType, trafficSourceType, ageGroup, gender."),
      filters: s("For example video==VIDEO_ID or country==US; join with ;."),
      sort: s("A metric to sort by; prefix with - for largest first."),
      maxResults: n("Rows to return, up to 200."),
    },
    ["startDate", "endDate"],
  ),
];

const instagramTools: McpToolCacheEntry[] = [
  tool("account", "This Instagram account: username, followers, post count, and how many posts it has made in the last 24 hours against the limit."),
  tool("publish_photo", "Publish one photo to the feed. The file must be a JPEG up to 8 MB.", { path, caption: s("Up to 2200 characters, 30 hashtags, 20 mentions."), altText: s("Description for people who cannot see the photo."), collaborators: strings("Up to 3 usernames invited as collaborators."), locationId: s("Id of a Facebook Page with a location."), userTags: tags, isAiGenerated: b("True when the photo is AI-generated.") }, ["path"]),
  tool(
    "publish_reel",
    "Publish a video as a reel. MP4 or MOV, 3 seconds to 15 minutes, up to 300 MB, 9:16 recommended. It can take a few minutes while Instagram processes it.",
    {
      path,
      caption: s("Up to 2200 characters."),
      coverPath: s("Path of a JPEG to use as the cover."),
      thumbOffsetMs: n("Or: the moment in the video to use as the cover, in milliseconds."),
      shareToFeed: b("False to show it in the Reels tab only."),
      audioName: s("Name for the reel's original audio."),
      collaborators: strings("Up to 3 usernames."),
      locationId: s("Id of a Facebook Page with a location."),
      userTags: tags,
      trial: s("Publish as a trial reel shown to non-followers first: MANUAL or SS_PERFORMANCE."),
      isAiGenerated: b("True when the video is AI-generated."),
    },
    ["path"],
  ),
  tool("publish_story", "Publish a photo (JPEG) or a video (MP4 or MOV, 3 to 60 seconds, up to 100 MB) as a story. Stories disappear after 24 hours.", { path, userTags: tags }, ["path"]),
  tool("publish_carousel", "Publish 2 to 10 photos and videos as one swipeable post. Photos must be JPEG.", { paths: strings("Paths of the files, in order."), caption: s("Up to 2200 characters."), altTexts: strings("One description per photo, in the same order."), collaborators: strings("Up to 3 usernames."), locationId: s("Id of a Facebook Page with a location.") }, ["paths"]),
  tool("list_media", "The account's posts, newest first, with likes and comment counts.", { limit: n("1 to 50; 10 when left out."), after: s("Cursor from the previous call.") }),
  tool("get_media", "One post's details and link.", { mediaId: s("Post id.") }, ["mediaId"]),
  tool("list_stories", "The account's stories that are live now."),
  tool("list_comments", "Comments on a post, with their replies.", { mediaId: s("Post id."), limit: n("1 to 50."), after: s("Cursor from the previous call.") }, ["mediaId"]),
  tool("post_comment", "Comment on one of the account's own posts.", { mediaId: s("Post id."), text: s("The comment.") }, ["mediaId", "text"]),
  tool("reply_to_comment", "Reply to a comment as the account.", { commentId: s("Comment id."), text: s("The reply.") }, ["commentId", "text"]),
  tool("hide_comment", "Hide a comment from everyone but its author, or show it again.", { commentId: s("Comment id."), hide: b("False to show it again.") }, ["commentId"]),
  tool("delete_comment", "Delete a comment on one of the account's posts.", { commentId: s("Comment id.") }, ["commentId"]),
  tool("set_comments_enabled", "Turn comments on or off for one post.", { mediaId: s("Post id."), enabled: b("False to turn comments off.") }, ["mediaId", "enabled"]),
  tool("media_insights", "How one post performed: views, reach, likes, comments, shares, saves, and watch time for a reel.", { mediaId: s("Post id."), metrics: strings("Metric names; the right ones for the post type when left out.") }, ["mediaId"]),
  tool(
    "account_insights",
    "Account statistics. Default metrics: reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, for the last day.",
    {
      metrics: strings("Metric names, for example reach, views, follows_and_unfollows, profile_links_taps, follower_demographics."),
      period: s("day, or lifetime for the demographics metrics."),
      metricType: s("total_value or time_series."),
      breakdown: s("For example media_product_type, follow_type, age, city, country, gender."),
      timeframe: s("For demographics: this_week or this_month."),
      since: s("Start of the range, Unix seconds."),
      until: s("End of the range, Unix seconds."),
    },
  ),
];

const tiktokPrivacy = s("PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR or SELF_ONLY; it must be one of the account's options from creator_info. SELF_ONLY when left out.");

const tiktokTools: McpToolCacheEntry[] = [
  tool("account", "This TikTok account: name, followers, likes, video count."),
  tool("creator_info", "What this account may post right now: its privacy options, the longest video it may post, and whether comments, duets and stitches are off."),
  tool(
    "post_video",
    "Post a video file from your computer to TikTok. MP4, MOV or WebM, up to 4 GB. Until TikTok has audited this server's app, only privacy SELF_ONLY is accepted. Waits a few minutes for the result.",
    {
      path,
      caption: s("Up to 2200 characters; hashtags and mentions work."),
      privacy: tiktokPrivacy,
      disableComment: b("True to turn comments off."),
      disableDuet: b("True to turn duets off."),
      disableStitch: b("True to turn stitches off."),
      coverTimestampMs: n("The moment in the video to use as the cover, in milliseconds."),
      brandedContent: b("True for a paid partnership promoting someone else's business."),
      ownBrand: b("True when it promotes the account's own business."),
      isAiGenerated: b("True when the video is AI-generated."),
    },
    ["path"],
  ),
  tool("upload_draft", "Send a video to the person's TikTok inbox as a draft. They finish the caption and post it in the TikTok app. Use this when a direct post is not allowed.", { path }, ["path"]),
  tool(
    "post_photos",
    "Post 1 to 35 photos (JPEG or WebP, up to 20 MB each) as one TikTok photo post. TikTok downloads them from this server, which works only once the server's domain is verified in the TikTok developer portal.",
    { paths: strings("Paths of the photos, in order."), title: s("Up to 90 characters."), description: s("Up to 4000 characters."), privacy: tiktokPrivacy, coverIndex: n("Which photo is the cover, from 0."), disableComment: b("True to turn comments off."), autoAddMusic: b("False to post without recommended music."), asDraft: b("True to send it to the person's TikTok inbox to finish there."), brandedContent: b("Paid partnership."), ownBrand: b("Promotes the account's own business."), isAiGenerated: b("True when the photos are AI-generated.") },
    ["paths"],
  ),
  tool("post_status", "Where a post stands: still processing, published (with its post id), sent to the inbox, or failed and why.", { publishId: s("The publishId a posting tool returned.") }, ["publishId"]),
  tool("list_videos", "The account's public videos, newest first, with views, likes, comments and shares.", { maxCount: n("1 to 20; 10 when left out."), cursor: n("cursor from the previous call.") }),
  tool("get_videos", "Statistics for specific videos by id.", { videoIds: strings("1 to 20 video ids.") }, ["videoIds"]),
];

/** Every Instagram and TikTok tool can be pointed at one of several signed-in accounts. */
function withAccount(tools: McpToolCacheEntry[], platform: string): McpToolCacheEntry[] {
  const account = s(`Which ${platform} account, by username, when more than one is connected. Leave out when there is only one.`);
  return tools.map((entry) => {
    const schema = entry.inputSchema as { properties: Record<string, Property> };
    return { ...entry, inputSchema: { ...schema, properties: { ...schema.properties, account } } };
  });
}

const publishRule = "Publishing is public and hard to take back. Show the person the file, the title or caption and the privacy setting, and publish only after they agree, unless they have told you to post without asking.";

export const SOCIAL_PLUGINS: CatalogPlugin[] = [
  {
    id: "youtube",
    name: "YouTube",
    description: "Upload videos and Shorts, manage playlists, comments and captions, and read channel analytics.",
    section: "Featured",
    kind: "google",
    provider: "google",
    mark: { icon: "https://www.gstatic.com/images/branding/product/1x/youtube_32dp.png", letter: "Y", color: "#FF0000" },
    skills: [
      {
        name: "youtube-publish",
        description: "Upload a video or Short to the person's YouTube channel and manage it afterwards.",
        body: [
          "Load the tools first with youtube_load_tools.",
          `1. ${publishRule}`,
          "2. Call youtube_upload_video with the file's path, a title and a description. It starts private; set privacy to public or unlisted when the person wants that, or publishAt to schedule it.",
          "3. A vertical video of three minutes or less is shown as a Short. Nothing else is needed.",
          "4. Add a thumbnail with thumbnailPath (JPEG or PNG, up to 2 MB) and captions with youtube_upload_caption.",
          "5. Report the link the tool returns. Processing takes a few minutes; youtube_get_video shows when it is done.",
          "YouTube allows about 100 uploads a day for the whole server. A failed upload can simply be tried again.",
          "For how the channel is doing use youtube_analytics; for comments, youtube_list_comments and youtube_reply_to_comment.",
        ].join("\n"),
      },
    ],
    scopes: [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ],
    tools: youtubeTools,
  },
  {
    id: "instagram",
    name: "Instagram",
    description: "Publish photos, reels, stories and carousels, answer comments, and read insights. Needs a professional account. Several accounts can be connected.",
    section: "Featured",
    kind: "google",
    provider: "instagram",
    app: {
      keyLabel: "Instagram app ID",
      secretLabel: "Instagram app secret",
      portal: "https://developers.facebook.com/apps",
      steps: [
        "Your Instagram account must be a professional one (business or creator). Switch it in the Instagram app's settings if it is not.",
        "At developers.facebook.com, create an app and add the Instagram product. Choose \"API setup with Instagram login\".",
        "Under Business login settings, add the redirect address shown below.",
        "Under App roles, add your Instagram account as an Instagram tester, then accept the invite in the Instagram app (Settings, Apps and websites).",
        "Copy the Instagram app ID and Instagram app secret into the two fields here.",
      ],
    },
    mark: { icon: null, letter: "I", color: "#E1306C" },
    skills: [
      {
        name: "instagram-publish",
        description: "Publish a photo, reel, story or carousel to the person's Instagram and follow up on it.",
        body: [
          "Load the tools first with instagram_load_tools.",
          "Several Instagram accounts can be connected. instagram_account lists them; pass account (the username) to every tool when there is more than one, and ask the person which one when they did not say.",
          `1. ${publishRule}`,
          "2. Get the file ready on your computer. Photos must be JPEG (convert with: convert in.png out.jpg). Reels are MP4 or MOV, 3 seconds to 15 minutes, up to 300 MB, best at 9:16; a video story is at most 60 seconds.",
          "3. Use instagram_publish_photo, instagram_publish_reel, instagram_publish_story or instagram_publish_carousel with the file's path. Video takes a few minutes while Instagram processes it.",
          "4. Report the link the tool returns.",
          "If Instagram cannot process a video, re-encode it: ffmpeg -i in.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4",
          "Instagram allows about 100 posts per day per account; instagram_account shows how many are used.",
          "For results use instagram_media_insights and instagram_account_insights; for comments, instagram_list_comments and instagram_reply_to_comment.",
        ].join("\n"),
      },
    ],
    scopes: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", "instagram_business_manage_insights"],
    tools: withAccount(instagramTools, "Instagram"),
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "Post videos and photo posts, send drafts to your TikTok inbox, and read video statistics. Several accounts can be connected.",
    section: "Featured",
    kind: "google",
    provider: "tiktok",
    app: {
      keyLabel: "Client key",
      secretLabel: "Client secret",
      portal: "https://developers.tiktok.com/apps",
      steps: [
        "At developers.tiktok.com, create an app.",
        "Add the products Login Kit and Content Posting API, and turn on Direct Post.",
        "Under Login Kit, add the redirect address shown below.",
        "Add the scopes user.info.basic, user.info.profile, user.info.stats, video.list, video.publish and video.upload.",
        "Copy the client key and client secret into the two fields here.",
        "Until TikTok has audited your app, posts can only be private; your agent posts as \"only me\" or sends a draft to your TikTok inbox.",
      ],
    },
    mark: { icon: null, letter: "T", color: "#111111" },
    skills: [
      {
        name: "tiktok-publish",
        description: "Post a video or photos to the person's TikTok, or send a draft to their TikTok inbox.",
        body: [
          "Several TikTok accounts can be connected. tiktok_account lists them; pass account (the username) to every tool when there is more than one, and ask the person which one when they did not say.",
          `1. ${publishRule}`,
          "2. Call tiktok_creator_info to see which privacy settings the account allows and how long a video may be.",
          "3. Call tiktok_post_video with the file's path, a caption and a privacy setting from that list. MP4 is safest.",
          "4. If TikTok answers that the app is not audited, it can only post privately: post with privacy SELF_ONLY and tell the person to change it in the app, or use tiktok_upload_draft so they finish the post themselves.",
          "5. The tool waits a few minutes. If it returns still processing, check later with tiktok_post_status.",
          "Photo posts (tiktok_post_photos) need the server's domain verified with TikTok; if that is refused, say so and offer a video instead.",
          "For results use tiktok_list_videos.",
        ].join("\n"),
      },
    ],
    scopes: ["user.info.basic", "user.info.profile", "user.info.stats", "video.list", "video.publish", "video.upload"],
    tools: withAccount(tiktokTools, "TikTok"),
  },
];
