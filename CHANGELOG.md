# Changelog

What changed in each release, newest first. Update your server with
`./update.sh`; see [Updating](deploy/SETUP.md#updating) for the phone app.

Each entry says whether it needs anything from the person running the
server (a new setting, a new app build) under **To update**.

## 0.4.0

**New**

- **YouTube, Instagram and TikTok plugins.** Agents publish to the person's
  own accounts and manage them, with no service in between. The person signs
  in once under Plugins; the server keeps and renews the sign-in.
  - YouTube: upload videos and Shorts, schedule, thumbnails, playlists,
    comments, captions, search, analytics.
  - Instagram: photos, reels, stories, carousels, comments, insights.
  - TikTok: videos, photo posts, drafts to the inbox, video statistics.
- Instagram and TikTok are connected in chat, not on the Plugins page. The
  person tells an agent "connect my Instagram"; it shows hidden fields for
  their own developer app's two keys and then a sign-in link. The model never
  sees a key, a token or the sign-in address. The connection belongs to that
  agent, so different agents can run different accounts with different apps,
  or one can be shared with all agents.
- One agent can hold several accounts on a platform and says which one by its
  username.
- A Linux server's NVIDIA graphics card is given to new account computers
  when Docker has the NVIDIA runtime, for rendering, video encoding and
  local models. `ACCOUNT_GPU=off` keeps it from them. See
  [Good to know](deploy/SETUP.md#good-to-know).
- **A voice.** The new `kokoro-tts` skill lets an agent speak a script on its
  own computer, with no key and no online service: narration for a video, an
  article read aloud. It gives the time of every line so a video can follow
  the voice. Nine languages; Persian, Arabic and German are not among them.
- An agent makes a video, a deck or a document itself when it has the skill,
  instead of pointing the person to a website.
- **Any kind of video, with HyperFrames.** The new `hyperframes` skill covers
  what the two video styles do not: a product video from a website, an
  explainer, captions on footage, a video cut to music. Its twenty skills are
  fetched into the project that needs them, so agents' prompts do not grow.
- An agent's computer now runs Node 22 (it was 18), which HyperFrames and
  other current tools need.
- A job no installed skill covers starts by looking for a proven one with
  `find-skills`. Only skills from known owners, or with 1,000 installs or
  more, are taken.
- With Auto-review on, a post, a delete or a public reply waits for the
  person's approval.

**Fixed**

- A skill that ships with the server now reaches the agent's computer whole:
  its scripts, templates and guides, not only its text. Before, a video made
  with `kinetic-reel` or `painted-animation` was built from nothing, because
  the template the skill told the agent to start from was not there. The two
  video skills also start without `rsync`, and say how to render on a Linux
  computer with or without a graphics card.
- An agent asks for memory before a heavy job by itself. The rule is now in
  every worker's instructions and in both video skills, not only in the
  tool's description.
- An agent no longer sends the same message or the same file over and over.
  When its work ended without finishing, it was woken, said "building it
  now", started the work again, and nothing limited how often. One request
  now gets at most six starts; after that the agent says where things stand
  and waits for the person.
- A secret field an agent typed out as text, `(widget: secret envName=...)`,
  is now shown as the hidden field it was meant to be.
- Phone app: typing in a chat no longer redraws every message and the chat
  list behind it, and a poll that brings nothing new redraws nothing.
- Phone app: avatars draw from the phone itself instead of downloading
  three.js first, and are baked without the pause between each one. A spinner
  shows until one is ready. They now work with no connection.
- Phone app: the message field follows the keyboard instead of jumping above
  it on Android, and the chat list no longer flickers where the keyboard was
  when going back from a chat.
- Phone app: Back from an agent's desktop or from Approvals returns to the
  chat it was opened from, not to the chat list.
- Phone app: reply by pulling a bubble to the right. On iOS 26 that pull used
  to close the chat; in a chat, Back is now the swipe from the left edge only.
- Phone app: the "Message from…" sheet, Select Text, the file viewer and a
  plugin's details all open the same way: the system page sheet on iOS,
  closed by dragging it down, and a page that slides up on Android.
- Phone app: a text or Markdown file opened from a chat scrolls properly.
- Phone app: the picture viewer zooms with a pinch or a double tap on Android
  as well as iOS, hides its buttons on a tap, and closes when the picture is
  dragged down. A single picture in a chat keeps its own shape.
- Phone app: a video takes its own shape once it plays, and uses the system
  player's own controls, full screen included; only Save stays beside its
  name. On Android those controls did not respond inside a chat bubble.
- Phone app: a sound file an agent sends (wav, mp3, m4a and others) plays in
  the chat, with play, pause and a bar to seek. It used to offer only the
  share sheet.
- Phone app: the desktop screen has a clipboard button. One row types what
  is copied on the phone into the agent's computer; the other puts what was
  last selected or copied on the computer onto the phone. Typing non-Latin
  text from the phone keyboard now sends the right keys as well.
- Phone app: a picture an agent sends as a file is shown in the chat like any
  other picture. It used to be a "Tap to open" row that handed it to other
  apps.
- Phone app: New chat has no title bar, and Send is an icon (an up arrow on
  iOS, a paper plane on Android).
- Phone app: a chat opens the moment it is tapped, on what was last seen of
  it, instead of after the server has answered.
- Phone app: the time above a message says the day it was sent (it always
  said "Today"), and appears for a new day or a pause, not for every minute.
- Phone app: in the light theme the keyboard is light, and pressing a row or
  a button shows.
- Android: the last rows of the account menu (Appearance) and of other pages
  are no longer hidden under the navigation bar.
- Android: the install file leaves out emulator-only code and unused
  resources, so it is smaller.

**To update**

- Run `./update.sh`. The database gains one small change by itself.
- Rebuild the computer image, for Node 22 on new computers:
  `docker build -t kuru-linux:1 apps/core/linux`. Existing computers get
  Node 22 by themselves on first use.
- For the graphics card: the NVIDIA Container Toolkit on the server; see
  deploy/SETUP.md, "Good to know". Computers made earlier do not get the card.
- YouTube: enable the YouTube Data API v3 and YouTube Analytics API on your
  Google project, and add the YouTube scopes to its consent screen.
- Instagram and TikTok: nothing on the server. Each person brings their own
  developer app. Steps: deploy/SETUP.md, "Social plugins".
- The phone app is now `com.kuru.app` and its link scheme is `kuru://` (they
  were `com.nanoagents.app` and `nano-agents://`). Update the server before
  installing a new build, or sign-in cannot return to the app. A new build
  installs as a separate app and asks for sign-in again; older builds keep
  working.
- The docs and `pnpm tunnel` now name the Cloudflare tunnel `kuru`. If yours
  is still called `nano-agents`, keep running it by that name.
- Tests now use a database named `kuru_database_test`, created on first run.
  The old `nano_agents_test` can be dropped.
- The phone fixes above need a new app build; an over-the-air update cannot
  deliver them, because the keyboard handling is native code.

## 0.3.0

**New**

- Memory is shared out from what the machine has. Each account's computer
  gets a small everyday limit (3 GB on a 16 GB machine), and one heavy job
  at a time may borrow most of the rest: about 10 GB on that machine, enough
  to render video. Workers ask with the new `computer_memory` tool and give
  it back when done; a second heavy job waits its turn.
- A computer may use every CPU core, at a lower priority than the server and
  the database. It was capped at two cores.

**Fixed**

- On an ordinary Linux disk, Docker refuses a per-container disk limit, and
  no account's computer could be created. The computer is now made without
  the limit there, with a warning in the log.
- If the machine runs out of memory, an agent's computer is given up before
  the server or the database.

**To update**

- Run `./update.sh`. Existing computers move from the old 10 GB limit to the
  everyday limit the next time the server starts, unless they are using more
  than that at the time.
- Optional: set `ACCOUNT_MEMORY_GB` in `apps/core/.env` to choose the
  everyday limit yourself.
- Protection from the memory killer applies to computers created from now
  on; Docker cannot change it on an existing one.

## 0.2.0

The first numbered release. The project is now called **Kuru** (it was
nano-agents).

**New**

- The server and the app report their versions. When one is too old for the
  other, the app says which side to update instead of failing oddly.
- `./update.sh` updates a Docker install in one step.
- Phone builds can receive app updates over the air, without a new APK.
- The context ring counts the tools, connector tools and skill list, and uses
  the provider's own count once a chat has run.
- A refused provider key or model id is explained under the button that was
  pressed.
- Pull down on the chat list to reload it.

**Changed**

- Skills that belong to one account (from a plugin, or approved by the
  person) are kept on that account's computer. The server's `skills` folder
  holds only the defaults. Older account skills are moved automatically.
- The database and the agents' computers start again when the machine
  restarts.
- The agents' computer image is `kuru-linux:1` (it was `nano-agents-linux:1`).

**To update**

- Build the image under its new name once:
  `docker build -t kuru-linux:1 apps/core/linux` (`./update.sh` does this).
- If you cloned the repository under its old name, point it at the new one:
  `git remote set-url origin https://github.com/shoodoow/kuru.git`.
- A new install names its database `kuru_database`. An install made before
  this release keeps `nano_agents`: leave `DATABASE_URL` in `apps/core/.env`
  as it is. Running the core with `docker compose --profile core` on an
  older database volume needs the old name; set it back in
  `docker-compose.yml` or start from a fresh volume.
- The app's bundle id and its `nano-agents://` link scheme keep the earlier
  name on purpose.
- Over-the-air updates need one new build of the phone app; builds made
  before this release keep working but do not receive them.
