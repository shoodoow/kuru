# Kuru — setup on a new machine

This guide covers **running Kuru on your own Linux machine with Docker and a Cloudflare Tunnel** (what most people want), building the phone app, and **development on a laptop**.

Replace `api.example.com` with your public hostname (this repo’s dev example uses `api.example.com`).

**In a hurry?**

- Running it for yourself on a Linux laptop or server, with a tunnel: go straight to [Install on Linux with Docker and a tunnel](#install-on-linux-with-docker-and-a-tunnel).
- Getting the app onto phones (Android APK, iPhone without the App Store): [Build the phone app](#build-the-phone-app).
- Developing on a laptop: follow sections 1 to 9 in order.

---

## What talks to what

| URL | Purpose |
|-----|---------|
| `https://api.example.com` | Public **core** API + Better Auth (`BETTER_AUTH_URL`, `EXPO_PUBLIC_CORE_URL`) |
| `https://api.example.com/api/auth/*` | Google OAuth and session cookies |
| `https://api.example.com/api/auth/callback/google` | **Google Cloud Console** authorized redirect URI (exact match) |
| `https://api.example.com/accounts/{accountId}/…` | Authenticated REST (agents, chat, desktop, …) |
| `wss://api.example.com/accounts/{accountId}/screens/{profile}?token=…` | Agent desktop stream (via tunnel; short-lived token from app) |
| `exp://YOUR_LAN_IP:8081` | **Expo Go** loads JS from your laptop (Metro); not the core API |
| `http://127.0.0.1:3000` | Core listening locally (tunnel origin) |

**Rule:** `BETTER_AUTH_URL` and `EXPO_PUBLIC_CORE_URL` must be the **same public HTTPS origin**. Never put a LAN IP in Google OAuth redirect URIs.

`EXPO_PUBLIC_CORE_URL` is the address a build starts with, not a fixed one. On the sign-in screen, **Server → Change** points the app at any other server, so people who run their own can use a published build without rebuilding it. Each server keeps its own sign-in on the phone, and each server needs its own Google OAuth credentials.

---

## Prerequisites

- **Node.js** ≥ 22.13, **pnpm** 12.6
- **Docker** (Postgres + agent Linux desktops)
- **cloudflared** ([install](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))
- A **domain on Cloudflare** (for tunnel DNS)
- **Google OAuth** client (Web application)
- For physical phones: **Expo Go** + same **Expo account** on laptop (`npx expo login`) and phone

---

## 1. Clone and install

```bash
git clone <your-repo-url> kuru
cd kuru
pnpm install
```

---

## 2. Database

```bash
docker compose up -d postgres
pnpm db:migrate
```

Default local DB (override in env):

`postgres://postgres:postgres@127.0.0.1:5432/kuru_database`

---

## 3. Core environment (`apps/core/.env`)

Copy `apps/core/.env.example` → `apps/core/.env`. Generate a strong secret:

```bash
openssl rand -hex 32
```

| Variable | Laptop + tunnel | VPS production |
|----------|-----------------|----------------|
| `DATABASE_URL` | Local Postgres URL | Managed Postgres URL (TLS) |
| `BETTER_AUTH_URL` | `https://api.example.com` | Same |
| `BETTER_AUTH_SECRET` | Random 32+ bytes hex | **Unique per environment** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From Google Cloud | Same |
| `HOST` | `0.0.0.0` (tunnel reaches localhost) | `127.0.0.1` if only tunnel/nginx connects |
| `PORT` | `3000` | `3000` (or behind reverse proxy) |
| `NODE_ENV` | Unset or `development` | `production` |
| `LOG_LEVEL` | `info` or `error` | `info` |

Do **not** commit `.env`. Do **not** reuse production secrets on a laptop.

`EXPO_PUBLIC_*` in core `.env` is unused; set mobile env separately.

---

## 4. Mobile environment (`apps/mobile/.env`)

```bash
EXPO_PUBLIC_CORE_URL=https://api.example.com
```

Restart Metro after changes: `pnpm --filter mobile start:clear`.

**Emulator-only (no tunnel):**

- Android emulator: `pnpm --filter mobile android:local` → `http://10.0.2.2:3000`
- iOS simulator: `pnpm --filter mobile ios` → `http://127.0.0.1:3000`

---

## 5. Google OAuth (Google Cloud Console)

1. [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) → **OAuth 2.0 Client ID** → type **Web application**.
2. **Authorized redirect URIs** — add exactly:

   `https://api.example.com/api/auth/callback/google`

3. Copy **Client ID** and **Client secret** into `apps/core/.env`.

Optional for local web-only dev (not for Expo on a phone): `http://127.0.0.1:3000/api/auth/callback/google`.

---

## 6. Cloudflare Tunnel (laptop or home PC)

Tunnel exposes **only** your core port. Postgres and Docker stay local.

### 6.1 Login and create tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create nano-agents
```

Note the tunnel UUID and credentials JSON under `~/.cloudflared/`.

### 6.2 DNS

```bash
cloudflared tunnel route dns nano-agents api.example.com
```

### 6.3 Ingress config (required — without this you get **503**)

Copy the example and edit paths:

```bash
cp deploy/cloudflared/config.example.yml ~/.cloudflared/config.yml
```

Example `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID-or-name>
credentials-file: /Users/YOU/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

The final `http_status:404` catch-all is **mandatory**.

### 6.4 Run tunnel

```bash
cloudflared tunnel run nano-agents
```

Keep this running (or install as a system service — see [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/)).

### 6.5 Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/api/auth/get-session
```

Expect `200`.

---

## 7. Start core

```bash
pnpm --filter core dev
```

Production on a server:

```bash
pnpm --filter core build
NODE_ENV=production node --env-file apps/core/.env apps/core/dist/main.js
```

Use **systemd**, **pm2**, or your platform’s process manager; restart on failure.

---

## 8. Mobile app (Expo Go)

From repo root:

```bash
pnpm --filter mobile start:clear
```

- **Android:** Expo Go → scan QR (or use URL from terminal).
- **iOS:** Camera app → scan QR (same Expo account as `npx expo login` on the laptop).
- **Manual URL:** paste `exp://…` from the terminal into Expo Go.

Google sign-in flow: app → `https://api.example.com` → Google → callback → back to Expo Go. If the browser tab sticks on Android after success, return to Expo Go manually once; the app should already be signed in.

---

## 9. Expo account and Metro (daily dev)

```bash
npx expo login
cd apps/mobile
pnpm start:clear       # from repo root: pnpm --filter mobile start:clear
```

EAS CLI is **not** installed globally by default. Use **`npx eas-cli`** (or `pnpm exec eas-cli` from `apps/mobile` after `pnpm add -D eas-cli`).

| Platform | Open the app |
|----------|----------------|
| **iOS device** | Camera → scan QR (same Expo account as CLI) |
| **Android device** | Expo Go → Scan QR |
| **Simulator** | Press `i` / `a` in Metro, or `pnpm --filter mobile ios` / `android:local` |

Metro URL (`exp://192.168.x.x:8081`) is **only** the JS bundle. The API stays `EXPO_PUBLIC_CORE_URL` (your public HTTPS core).

---

## 10. Push notifications

The core sends pushes via [Expo Push API](https://docs.expo.dev/push-notifications/sending-notifications/) (`exp.host`). After sign-in, the app registers an **Expo push token** with `POST /devices` on the core.

### What works where

| Runtime | Remote push |
|---------|-------------|
| **Expo Go on Android** | **No** (SDK 53+; app skips token registration) |
| **Expo Go on iOS** | Unreliable for production; use a dev build for real push |
| **EAS development / production build** | **Yes** (recommended) |

Without `extra.eas.projectId` in app config, `getPushToken()` returns null — chat still works via SSE while the app is open.

### One-time EAS setup

From `apps/mobile`:

```bash
cd apps/mobile
npx eas-cli login
npx eas-cli init   # links project; adds projectId under expo.extra.eas in app.json
```

Confirm `apps/mobile/app.config.js` keeps merged `extra` (it spreads `app.json`’s `extra`, including `eas.projectId`).

### Credentials (dev / store builds)

1. **iOS** — Apple Developer account required. On first `npx eas-cli build`, accept **Setup Push Notifications** and generate an **APNs key** (or `npx eas-cli credentials` → iOS → Push Notifications).
2. **Android** — `npx eas-cli credentials` → Android → **Push Notifications: FCM** and upload/create a Firebase **FCM v1** service account key ([Expo FCM guide](https://docs.expo.dev/push-notifications/fcm-credentials/)).

### Install a development build on your phone

```bash
cd apps/mobile
npx eas-cli build --profile development --platform ios     # or android
# install the build from the EAS link (or internal distribution)
npx expo start --dev-client
```

Use the **development build** (not Expo Go) for push on both platforms. Keep `EXPO_PUBLIC_CORE_URL` pointed at your tunnel/VPS core.

### Verify push end-to-end

1. Core running and reachable from the phone.
2. Sign in with Google in the app.
3. Allow notifications when prompted.
4. Background the app and trigger an agent notification (e.g. approval / action-needed ping).
5. Tap notification — app should open the room from push `data`.

Core does **not** need an Expo secret for basic push send; optional [Expo access token](https://docs.expo.dev/accounts/programmatic-access/) helps for higher-volume or secured sends later.

---

## Production on a VPS (recommended)

| Topic | Recommendation |
|-------|----------------|
| **Host** | Small VPS (2+ vCPU, 4GB+ RAM) with Docker; same machine runs core + Postgres or use managed DB |
| **Public access** | Cloudflare Tunnel **on the server** (no open `:3000` on the public internet) or nginx + TLS + `cloudflared` only to localhost |
| **Secrets** | New `BETTER_AUTH_SECRET`, DB password, Google client (or separate OAuth client per env) |
| **NODE_ENV** | `production` — requires HTTPS `BETTER_AUTH_URL` and Google credentials |
| **Firewall** | Allow SSH; deny public 3000/5432; optional Cloudflare Access on `api.example.com` |
| **Backups** | Volume snapshots or `pg_dump` for Postgres |
| **Updates** | `git pull`, rebuild, `docker compose --profile core up -d --build` (see [Install on Linux](#install-on-linux-with-docker-and-a-tunnel)) |

Laptop + tunnel is fine for **personal dev**; for anything shared or always-on, run core on a VPS and point `EXPO_PUBLIC_CORE_URL` at that hostname.

---

## Security checklist

- [ ] `.env` files gitignored; never commit secrets (rotate anything ever committed).
- [ ] `BETTER_AUTH_SECRET` ≥ 32 characters; different per environment. The core refuses to start without it, and it also seals every stored API key, so changing it later makes saved keys unreadable.
- [ ] Google redirect URI is **HTTPS only** on your public hostname.
- [ ] Tunnel ingress points to `127.0.0.1:3000`, not `0.0.0.0` on the WAN.
- [ ] Production: `NODE_ENV=production`, strong DB credentials, Postgres not exposed publicly (the bundled compose file binds it to `127.0.0.1`).
- [ ] A tunnel or reverse proxy on the same machine needs no setting. If the proxy runs on another host, set `TRUST_PROXY=1` so request limits count each client, not the proxy.
- [ ] Restrict Google OAuth client to your redirect URIs; use separate clients for dev/prod if possible.
- [ ] Optional: Cloudflare **Access** policy on `api.example.com`; WAF / rate limiting on the zone.
- [ ] Keep `cloudflared` and dependencies updated.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tunnel **503** | Add `ingress` in `~/.cloudflared/config.yml`; restart `cloudflared tunnel run` |
| Phone still uses old **192.168…** API | `apps/mobile/.env` → public HTTPS; `pnpm --filter mobile start:clear` |
| Google sign-in fails | Redirect URI exactly `https://api.example.com/api/auth/callback/google`; restart core after `BETTER_AUTH_URL` change |
| **401** on agents/chat | Sign in again; check `EXPO_PUBLIC_CORE_URL` matches `BETTER_AUTH_URL` |
| Desktop stuck on **Connecting** | Restart core (ws-token support); agent must have `linuxProfile`; tunnel must allow **WebSockets** |
| iOS Expo “sign in required” | Same Expo account on CLI and Expo Go |
| No push on Android | Expected in **Expo Go** — use an **EAS development build** + FCM credentials |
| Push never registers | Run `npx eas-cli init`; check `expo.extra.eas.projectId`; grant notification permission |
| `eas: command not found` | Use `npx eas-cli …` or install globally: `npm install -g eas-cli` |

---

## Quick reference — files

| File | Role |
|------|------|
| `apps/core/.env` | Core, auth, Google, DB |
| `apps/mobile/.env` | `EXPO_PUBLIC_CORE_URL` |
| `~/.cloudflared/config.yml` | Tunnel ingress |
| `deploy/cloudflared/config.example.yml` | Template for tunnel config |
| `docker-compose.yml` | Postgres, and the core with `--profile core` |
| `apps/mobile/eas.json` | Build profiles for the phone app |

## Install on Linux with Docker and a tunnel

The usual way to run Kuru for yourself or a small group: a Linux laptop,
home PC or server that stays on, with a Cloudflare Tunnel so phones can
reach it from anywhere. No static IP, no open ports, no Node.js on the
machine. Everything runs in Docker: the database, the core, and one Linux
computer per account.

**You need:**

- A Linux machine with 2+ CPU cores and 4 GB+ memory
- A domain managed by Cloudflare (the free plan is enough), for an address
  like `api.example.com`
- A Google account, to create the sign-in client

### Step 1. Docker and the code

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker

git clone https://github.com/shoodoow/kuru.git && cd kuru
```

### Step 2. The tunnel

Install `cloudflared` ([downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
On Debian or Ubuntu:

```bash
curl -fsSL -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

Create the tunnel and give it your address:

```bash
cloudflared tunnel login                      # opens a browser; pick your domain
cloudflared tunnel create kuru                # prints the tunnel id
cloudflared tunnel route dns kuru api.example.com
```

Write `~/.cloudflared/config.yml` (the example is in
`deploy/cloudflared/config.example.yml`):

```yaml
tunnel: kuru
credentials-file: /home/YOU/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

The last line is required; without it every request answers 503.

### Step 3. Google sign-in

In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials),
create an **OAuth 2.0 Client ID** of type **Web application** and add this
redirect address exactly:

`https://api.example.com/api/auth/callback/google`

Keep the client id and secret for the next step.

### Step 4. Settings

```bash
cp -n apps/core/.env.example apps/core/.env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env    # read by docker compose
```

Fill in `apps/core/.env`:

| Variable | Value |
|----------|-------|
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32`. Keep it safe: it signs sessions and seals saved provider keys. A lost secret makes every saved key unreadable. |
| `BETTER_AUTH_URL` | `https://api.example.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From step 3 |
| `NODE_ENV` | `production` |

`DATABASE_URL`, `HOST` and `TRUST_PROXY` are set by compose; leave them
alone. `SKILLS_DIR` can stay empty: the image ships the default skills.

The database password in `.env` is used only when the database is first
created. Do not change it afterwards, and back the file up with your data.

### Step 5. Start

```bash
docker build -t kuru-linux:1 apps/core/linux         # the agents' computer image; takes a while the first time
docker compose --profile core up -d --build

curl -fsS http://127.0.0.1:3000/health               # {"ok":true}

sudo cloudflared --config ~/.cloudflared/config.yml service install   # the tunnel starts with the machine
curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/api/auth/get-session   # 200
```

To run the tunnel by hand instead of as a service: `cloudflared tunnel run kuru`.

### Step 6. The phone

Install the app (see [Build the phone app](#build-the-phone-app)), tap the
server address at the bottom of the welcome screen, enter
`https://api.example.com` under **Server**, and sign in with Google. Then
add a model key under **Account → AI Providers**. One build of the app works
with any server.

### Good to know

- **The image name** must be exactly `kuru-linux:1`, or a new account's
  computer cannot be created.
- **Memory is shared out by the server, from what the machine has.** It keeps
  about 4 GB back for itself, the database and the system. Each account's
  computer gets a small everyday limit (3 GB on a 16 GB machine), and one
  heavy job at a time, such as a video render, may borrow most of the rest
  (about 10 GB on that machine) and gives it back when done. A second heavy
  job waits its turn. To fix the everyday limit yourself, set
  `ACCOUNT_MEMORY_GB` in `apps/core/.env`.
- **CPU is not capped.** A computer may use every core, at a lower priority
  than the server and the database, so chats stay quick while agents work.
- **If the machine still runs out of memory,** Linux stops a process in an
  agent's computer before it touches the server or the database. Adding swap
  to the machine turns a small overshoot into a slowdown instead.
- **Disk:** each computer is limited to 50 GB where Docker supports that
  (xfs with project quotas). On an ordinary disk the limit is not applied and
  the server logs a warning once per new computer.
- **After a restart** of the machine the database, the core, the agents'
  computers and the tunnel come back by themselves. If something is missing, run
  `docker compose --profile core up -d` in the `kuru` folder.
- **A laptop that sleeps stops answering.** To keep it running with the lid
  closed, set `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf` and
  restart `systemd-logind`; also turn off automatic suspend in the power
  settings.
- **Database migrations** run each time the core container starts.
- **The core listens on `127.0.0.1:3000` only.** The tunnel is the one way in;
  the database is never offered to the network.
- **The Docker socket** is mounted into the core so it can create account
  computers. That gives the core container full control of the machine. Use
  a machine where that is acceptable.
- **People you do not know:** with plain Docker every account's computer
  shares the machine's kernel. Read the Kata section below before opening
  sign-up to strangers.
- **No domain yet?** `cloudflared tunnel --url http://127.0.0.1:3000` gives a
  temporary `trycloudflare.com` address for a first look. It changes on every
  start, and `BETTER_AUTH_URL` and the Google redirect address must change
  with it, so it is not for regular use.
- **Logs:** `docker compose logs -f core`.

## Updating

New code never reaches an install by itself. Whoever runs a server updates
it; the phone app is updated separately.

### The server

```bash
cd kuru
./update.sh
```

The script pulls the newest code, rebuilds the agents' computer image and
the server, restarts it, and waits until it answers. What it leaves alone:

- **Your data.** The database, saved keys and every account's computer are
  in Docker volumes.
- **Your settings.** `apps/core/.env` and `.env` are not in git. When a
  release needs a new setting, `CHANGELOG.md` says so under **To update**.
- **Existing agents' computers.** They are not rebuilt; the server repairs
  what it needs on them.

The database is migrated as the server starts. The server is away for the
few seconds of the restart, and agent work running at that moment is cut
off, so pick a quiet time. Read `CHANGELOG.md` first to see what changed.

To stay on a known release instead of the newest code:
`git fetch --tags && git checkout v0.2.0`, then
`./update.sh --force`.

### The phone app

| How the app was installed | How it updates |
|---------------------------|----------------|
| Expo Go | It loads the newest code each time it connects to the dev server |
| An APK or iPhone build | Over the air, when the person who made the build publishes an update (below). Changes to native code need a new build. |

Publishing an update to the builds you made, from `apps/mobile`:

```bash
npx eas-cli update --channel preview --message "what changed"
```

Phones check when the app opens, download in the background, and show the
new version the next time the app is opened. An update only reaches builds
with the same `version` in `apps/mobile/app.json`; raise that number when
you add or upgrade a native library, and make a new build then.

Updates come from the Expo project the build was made in. If you build the
app yourself, run `npx eas-cli init` first so the project (and its updates)
is your own.

### When the app and the server drift apart

The server reports its release on `/health`, and the app compares it with
its own. If one is too old for the other, the app says so on the welcome
page and at the top of the chat list, and names which side to update.

## Build the phone app

Expo Go is enough to try the app, but it cannot receive push notifications
and needs your laptop running. A real build is a file you install once.
Builds are made with [EAS](https://docs.expo.dev/build/introduction/); the
profiles are in `apps/mobile/eas.json`.

Set the server a build opens with in `apps/mobile/.env`
(`EXPO_PUBLIC_CORE_URL`). It is only the default: anyone can change it on the
sign-in screen. For a build that may talk to a plain `http://` server on a
home network, also set `EXPO_PUBLIC_ALLOW_HTTP=1`.

### Android: an APK anyone can install

```bash
cd apps/mobile
npx eas-cli login                                        # a free Expo account
npx eas-cli build --profile preview --platform android
```

The build runs on Expo's servers and ends with a link to an `.apk`. Send
the link or the file; the person opens it on their phone and allows
"install from unknown sources". No Google Play account is needed. Push
notifications on Android also need the FCM key from section 10.

To build on your own machine instead (needs the Android SDK and JDK 17):

```bash
cd apps/mobile
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
# the file: android/app/build/outputs/apk/release/app-release.apk
```

### iPhone without the App Store

Apple does not allow a freely installable file like an APK. The choices:

| Way | Needs | Limits |
|-----|-------|--------|
| **Ad hoc build** (recommended for a few people) | Paid Apple Developer account ($99 a year) | Each iPhone is registered first; up to 100 phones a year; a build lasts one year |
| **TestFlight** | Paid Apple Developer account | Up to 10,000 testers by email or link; a build lasts 90 days; outside testers wait for a short Apple review |
| **Your own phone from Xcode** | A free Apple ID and a Mac | Your own devices only; the app stops opening after 7 days and is installed again |

Ad hoc, step by step:

```bash
cd apps/mobile
npx eas-cli device:create                                # gives a link; each person opens it on their iPhone to register it
npx eas-cli build --profile preview --platform ios       # sign in with the Apple Developer account when asked
```

The build ends with a link and a QR code. A registered iPhone opens it in
Safari and installs the app. A phone added later needs a new build.

Free, on your own iPhone, from a Mac with Xcode:

```bash
cd apps/mobile
npx expo run:ios --device --configuration Release
```

Xcode signs it with your Apple ID. On the phone, trust the developer under
Settings → General → VPN & Device Management.

### Keeping the app's identity

The app name is Kuru, but its bundle id (`com.nanoagents.app`) and link
scheme (`nano-agents://`) keep the earlier name. Sign-in returns to the app
through that scheme, and a phone treats a different bundle id as a different
app, so they are left as they are.

## Stronger isolation with Kata Containers (Linux servers)

With plain Docker every account's container shares the server's kernel. For a
server that strangers can sign up on, run each container in its own small
virtual machine instead.

1. Use a Linux server with KVM (`ls /dev/kvm`). Docker Desktop on a Mac has
   no KVM, so a Mac stays on plain Docker; nothing needs to be set there.
2. Install Kata Containers and register it with Docker as a runtime. Check
   the name Docker lists: `docker info --format '{{json .Runtimes}}'`.
3. Set `CONTAINER_RUNTIME` in `apps/core/.env` to that name and restart the core.

What changes when it is set:

- New account containers are created with that runtime. A container made
  earlier with another runtime is refused with a message, because a runtime
  cannot be changed afterwards: remove it and it is created again. Files in
  agents' home folders live in the container and are lost with it.
- The network rules move from each container to the host, on one bridge
  (`nano0`) all account containers share. They are installed by a short
  helper container that uses the host network with the `NET_ADMIN` capability.
- Containers use the name servers in `CONTAINER_DNS` (default 1.1.1.1 and 8.8.8.8).

The host-side rules can be tried without Kata by setting
`CONTAINER_FIREWALL=host`. That path is tested on plain Docker. Starting
containers under Kata itself has not been run by the project's tests.
