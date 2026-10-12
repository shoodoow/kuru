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
- With Auto-review on, a post, a delete or a public reply waits for the
  person's approval.

**Fixed**

- A secret field an agent typed out as text, `(widget: secret envName=...)`,
  is now shown as the hidden field it was meant to be.

**To update**

- Run `./update.sh`. The database gains one small change by itself.
- YouTube: enable the YouTube Data API v3 and YouTube Analytics API on your
  Google project, and add the YouTube scopes to its consent screen.
- Instagram and TikTok: nothing on the server. Each person brings their own
  developer app. Steps: deploy/SETUP.md, "Social plugins".

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
