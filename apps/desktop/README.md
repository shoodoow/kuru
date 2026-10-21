# Kuru desktop (Mac and Windows)

A small Electron window around the web app that the server serves at `<server>/app`.
The app's screens are the same code as the phone app (`apps/mobile`); this folder adds only the desktop pieces.

| File | What it does |
| --- | --- |
| `src/main.cjs` | The window, the menu, right-click menus, links opening in the browser, the Dock badge, the saved server address |
| `src/sign-in.cjs` | Google sign-in in the person's own browser; the session comes back through a `kuru-desktop://` link |
| `src/preload.cjs` | The few calls the page can make: `kuruDesktop.signIn`, `setBadge`, `focus`, `setServer` |
| `src/server.html` | The page for choosing the server, shown when it cannot be reached or from **Change Server…** |

Desktop behaviour that lives in the app itself (`apps/mobile`), so it works in a browser too:

- drag and drop and paste to attach: `src/desk/FileDrop.tsx`
- notifications and the unread badge: `src/desk/notify-web.ts`
- playing and saving files: `src/chat/file-web.ts`
- right-click on a message: `src/chat/ChatScreen.tsx`

## Run

```sh
pnpm --filter mobile build:web   # the server serves this at /app
pnpm --filter core dev           # local server on :3000
pnpm --filter desktop dev        # the window, pointed at http://127.0.0.1:3000
```

`pnpm --filter desktop start` uses `https://kuru.octessa.com`. Set `KURU_SERVER_URL` to point it elsewhere.
The address someone picks in the app is saved in the app's settings file and is used ahead of the default.

## Build

```sh
pnpm --filter desktop dist:mac   # dist/Kuru-<version>-mac-arm64.dmg and -x64.dmg
pnpm --filter desktop dist:win   # dist/Kuru-<version>-win-x64.exe
```

The builds are not signed yet. macOS asks to confirm opening the app (right-click, then Open), and Windows SmartScreen shows a warning.
To sign them, set the electron-builder signing variables (`CSC_LINK`, `CSC_KEY_PASSWORD`, plus `APPLE_ID` and related for notarizing).
