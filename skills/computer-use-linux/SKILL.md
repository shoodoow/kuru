---
name: computer-use-linux
description: 'Drive this agent''s Linux desktop (1280×800): text-first observation, rare screenshots, click/type/key, Chromium reuse, xterm, and NEEDS_PERSON handoffs. Use for GUI apps and login-gated screens — not for public web (prefer chrome-devtools / web_fetch).'
license: MIT
platforms: [linux]
---

# computer-use-linux

How to talk to **this bot's Linux computer** — the assigned X11 desktop, not a generic VPS setup guide.

Adapted from [agent-sh/computer-use-linux](https://github.com/agent-sh/computer-use-linux) (AT-SPI / text-first desktop control). Here the runtime tools are `bash`, `computer_*`, `web_fetch`, and `browser_*` from the `chrome-devtools` skill. Browser control stays inside this account's computer.

## When to Use

- Control a GUI app on this agent's screen (dialogs, native apps, signed-in Chromium).
- Need desktop state before a click or type.
- Login wall, captcha, or payment screen that may need `NEEDS_PERSON`.

Do **not** use this for public pages you can read with `web_search` / `web_fetch`, or for in-page automation when `chrome-devtools` is available. Browser content → text/DOM first; this skill is for the **desktop surface**.

## Environment (fixed)

- Screen: **1280×800**. Coordinates: **0–1279** × **0–799**.
- `DISPLAY` is already set. Never start Xvfb, never override `DISPLAY`.
- Chrome DevTools is **per agent**: `--remote-debugging-port=$((9200 + ${DISPLAY#:}))` — never use port 9222 (that belongs to another agent on the same computer).
- Never `pkill chromium`, never "close all Chrome", never open a second browser if one is already on screen.
- One desktop worker at a time; serialize mutating GUI actions.
- Home is private; `/shared` is account-wide. Screenshots land under `/shared/screenshots/…`.

## Tools

| Goal | Tool |
|------|------|
| Shell / install / launch | `bash` |
| Move pointer | `computer_mouse` |
| Click | `computer_click` (x, y) |
| Type into focused field | `computer_type` |
| Keys (Return, Tab, Escape, ctrl+…) | `computer_key` |
| Camera (expensive) | `computer_screenshot` |
| Page as text | `web_fetch`, or `browser_read` for a live page |
| In-page structure / uids | `read_skill chrome-devtools` → `browser_snapshot` |

Do **not** drive the GUI from bash: no `xdotool`, Playwright, Puppeteer, cookie files, or page JS for clicks. A terminal on the screen: `xterm >/dev/null 2>&1 &`. Missing program: `sudo apt-get install`.

## Procedure (text → act → text)

Images burn tokens on every later step. Prefer text observation; screenshot only when text cannot answer.

1. **Scope the surface** — Chromium vs other app. Reuse the open Chromium window.
2. **Prefer text state**
   - Public / readable page: `web_fetch`. A live page: `browser_read`. Never a headless browser.
   - Live page interaction: `read_skill chrome-devtools` → `browser_snapshot` → click/fill by ref.
   - Known UI from the brief: `computer_key` (Tab / Return / shortcuts) without a shot.
3. **Open URLs with the browser tools** — `open_on_screen` or `browser_navigate` with the exact address. They start the visible Chromium themselves and reuse its window; never launch it from `bash`.

4. **Act** with `computer_click` / `computer_type` / `computer_key`. After a DOM/page change, coordinates and uids go stale — refresh text state (`browser_snapshot`, or one screenshot if unavoidable) before the next pixel click.
5. **Bulk data** — `write` a file, then upload/import. Do not type cell by cell.
6. **Verify** with text again. Cite screenshot **paths** in Findings if you shot; never paste base64/bytes to the parent.

## Screenshots (last resort)

Use `computer_screenshot` only when:

- Layout is unknown and no `browser_snapshot` or prior description exists, or
- The task explicitly needs visual proof, or
- Canvas/captcha/pixels with no useful text tree.

Rules:

- Never re-shoot an unchanged screen.
- After 1–2 shots, switch back to text methods. After ~8 shots the camera stops — continue with `browser_snapshot` / remembered coords.
- Describe what you saw; cite `/shared/screenshots/…`.

## Safety

- Never type a password, 2FA code, or payment.
- A login is not a stop before the page is open. Open it; if the screen waits on the person, end with:  
  `NEEDS_PERSON: <one instruction>`
- Blank or repeating identical screens → stop and report. Do not keep clicking.
- Do not invent Settings paths or recovery buttons you have not observed.

## Pattern A: Desktop app (non-browser)

```markdown
1. Launch or focus the app (bash / known shortcut).
2. Prefer keys and remembered layout from the brief.
3. One computer_screenshot only if you must locate a control.
4. computer_click / computer_type / computer_key.
5. Verify with another text check or a single follow-up shot if required.
```

## Pattern B: Signed-in Chromium (login-gated)

```markdown
1. Reuse open Chromium; open the exact URL (background launch if needed).
2. `browser_snapshot` (or `browser_read` / `web_fetch`) — not a screenshot.
3. Interact by uid when DevTools is available; else one screenshot then computer_*.
4. If auth wall needs the person → NEEDS_PERSON.
```

## Pattern C: Failure / stuck

```markdown
1. Confirm you are on the intended window (title / URL / snapshot).
2. Retry once with fresh text state.
3. Report Blockers; do not thrash clicks.
```
