# Nano Agents — setup on a new machine

This guide covers **production-style hosting on a VPS** (recommended) and **development on your laptop** with a **Cloudflare Tunnel** so phones can reach the API without a static home IP.

Replace `api.example.com` with your public hostname (this repo’s dev example uses `api.example.com`).

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
git clone <your-repo-url> nano-agents
cd nano-agents
pnpm install
```

---

## 2. Database

```bash
docker compose up -d postgres
pnpm db:migrate
```

Default local DB (override in env):

`postgres://postgres:postgres@127.0.0.1:5432/nano_agents`

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
| **Updates** | Pull repo, `pnpm install`, `pnpm db:migrate`, restart core |

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
| `docker-compose.yml` | Local Postgres |

## Running the core as a container

On a server the core can run from an image instead of `pnpm --filter core dev`:

```bash
docker build -t nano-agents-linux:1 apps/core/linux   # the agents' computer image
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"    # keep it; the database volume remembers it
docker compose --profile core up -d --build
```

- Settings come from `apps/core/.env`. `DATABASE_URL`, `HOST` and `TRUST_PROXY` are set by compose.
- Database migrations run each time the container starts.
- The core is published on `127.0.0.1:3000` only; point the tunnel or reverse proxy at it.
- The Docker socket is mounted into the core so it can create account
  containers. That gives the core container full control of the host, which
  is the same trust the core has when run directly.

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
