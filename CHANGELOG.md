# Changelog

What changed in each release, newest first. Update your server with
`./update.sh`; see [Updating](deploy/SETUP.md#updating) for the phone app.

Each entry says whether it needs anything from the person running the
server (a new setting, a new app build) under **To update**.

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
