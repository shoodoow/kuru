---
name: chrome-devtools
description: How to use a website in your own browser the way a person does - open pages, read them, click, type, fill forms, choose from menus, upload and download files, work across tabs, get past cookie and ad overlays, stay signed in, and keep notes about each site. Use for any job on a live web page - a dashboard, a social network, a web app, a shop, a form, anything a plain page fetch cannot read or that needs clicking or a login.
license: MIT
---

# Using a website in your browser

You have a real Chromium window on your desktop. The person can watch it and take over. It keeps its cookies, so a
site you (or they) signed in to once stays signed in. The `browser_*` tools drive that window with real mouse and
keyboard input. They start it themselves: never launch a browser from `bash`, never run one headless, never
`pkill chromium`.

## The loop

1. **Go.** `browser_navigate` to the deepest address you know. The result is already the page: its text and a ref
   (`e12`) on everything you can act on. Read it before doing anything else, and read your notes on the site if the
   result shows any.
2. **Act** on one thing by its ref: `browser_click`, `browser_fill`, `browser_type`, `browser_select`,
   `browser_check`.
3. **Look again.** After anything that changes the page, take a `browser_snapshot`. Refs from before the change may
   be gone; an "Unknown ref" answer means exactly that.
4. Repeat until the job's goal is met, then stop and report.

## Which tool

| You want to | Use |
|---|---|
| Get the answer out of a page (an article, prices, a table, a status) | `browser_read`; with `uid` for just one part |
| Find what to click on a long page | `browser_snapshot` with `interactive: true` |
| See more of a page that loads as you go | `browser_scroll`, then snapshot |
| Put text in a normal form field | `browser_fill` (it clears the field first) |
| Type where the page reacts to every key: search with suggestions, chat boxes, editors | `browser_type`; `enter: true` to send |
| Submit a form | click its button, or `browser_press_key` `Enter` in the field |
| Set a date, a time, a slider or a colour | `browser_set_value` with the field's name from the list under the snapshot: `13:45`, `2026-10-20`. Never `browser_fill` or typing into its parts |
| Pick from a dropdown | `browser_select` with the option's visible label. A custom menu that is not a real dropdown: click it, snapshot, click the option |
| Open a menu that appears on hover | `browser_hover`, then snapshot |
| Tick a box or radio button | `browser_check` |
| Attach a file | `browser_upload` on the file field (the file is under your home or `/shared`) |
| Save a file the site offers | `browser_download`; it lands in `~/Downloads` |
| Move or reorder something | `browser_drag` |
| Use something with no ref: a canvas, a map, a chart, a custom widget | `browser_screenshot` to see it, then `browser_click_at` its position |
| A link opened another tab | `browser_tabs` `list`, then `switch` |
| Keep one page while checking another | `browser_tabs` `new`, and `close` it when done |
| The page is stuck or stale | `browser_reload`; `browser_back` to return |
| Wait for something slow | `browser_wait_for` the text you expect |
| A JavaScript alert or confirm is blocking | `browser_handle_dialog` |
| Read a value the page does not show | `browser_eval`, as a last resort |

## Work like a person

- **Look before you act.** One snapshot tells you where you are: signed in or not, which page, what is in the way.
- **Clear what is in the way first.** A cookie banner, a newsletter pop-up, an "open in app" sheet or an ad has a
  Close, X, Skip, "Not now", "No thanks" or "Accept" control: click it, or press `Escape`, then snapshot. That is
  an overlay, not a captcha and not a blocker.
- **Use the site the way it is built.** Its own search box, its filters, its menus and its "next page" link are
  faster and more reliable than guessing addresses.
- **After filling a form, read it back** with a snapshot before you submit: every field should hold what you meant. A field holding another field's text means your typing went to the wrong place; correct both.
- **One step, then check.** After a click that should change something, confirm it did (the new page title, the
  new text) before the next step. If nothing changed, look at the snapshot for why (a required field, an error
  message, a disabled button) instead of clicking again.
- **Go at a person's pace.** No rapid repeated clicks, no reloading in a loop, no opening dozens of tabs. A site
  that sees a burst of actions slows you down or locks the account.
- **Long pages:** scroll and read in parts. "Load more" and endless feeds need `browser_scroll` before the rest
  exists.
- **Prefer text to pictures.** A snapshot costs a fraction of a screenshot. Take a screenshot only for what text
  cannot show.

## Signing in, codes and payment

A sign-in form, a 2FA code, a captcha with a real challenge, or a payment form is the person's to do. Stop there
and end your report with `NEEDS_PERSON: <exactly what to do on the screen>`. Never type a password, a code or a
card number, even if you were given one. Once they have signed in, the site stays signed in for later jobs.

A page that says "enable JavaScript", "verify you are human" or "unusual traffic" with none of the site's own
content is a bot wall. Say so under Blockers. Do not call it a captcha on the site, and do not invent what the page
would have shown.

## When you cannot do a step yourself

Try it properly first: the right tool from the table, a fresh snapshot, a second way (`browser_set_value`, `browser_type`, `browser_click_at` after a screenshot). If it still will not work, decide how much it matters:

- **The job cannot finish without it** (a required field, the button that submits): do everything else, leave the page on that exact spot, and end your report with `NEEDS_PERSON: <one precise instruction>`, for example "pick 13:45 in the Delivery time field and press Submit order". The person does that one step on your screen and the job carries on.
- **It is optional or small** (a comment box, a preference): skip it, finish the job, and say under Blockers what you left out.

Never report the job as done with that step missing, and never guess what the page would have shown.

## Notes about a site

Each website has one note: `/shared/notes/sites/<host>.md` (the path is in every `browser_navigate` result). It is
shown to you, and to every other agent on this account, each time the site is opened. Before you finish a job on a
site, write or correct a few lines there with `write`:

- whether it is signed in, and as which account;
- the direct addresses of the pages that matter (the dashboard, the upload page, the inbox);
- where the thing you needed was, and the steps that worked;
- what got in the way and how you got past it.

Keep it short and true. Fix a line that turned out wrong; do not keep a second version beside it. Never write a
password, a code or a token there.

## When it does not work

- "Unknown ref": the page changed. Snapshot again.
- A click that does nothing twice: the element may be covered (close the overlay), disabled (something is
  required first) or not the real control (snapshot with `interactive: true` and pick the button or link inside it).
- A field that ignores `browser_fill`: click it, then `browser_type`.
- The browser tools say the browser did not start, or are still being installed: report that exact message under
  Blockers. Do not try to fix the browser from the shell.

Not the browser: a public page you only need to read goes through `web_fetch`, which is quicker. A program on the
desktop that is not a web page goes through the `computer-use-linux` skill.
